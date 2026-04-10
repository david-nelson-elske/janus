/**
 * City news RSS connector — sync news items from municipal newsroom.
 */
import { handler, SYSTEM } from '@janus/core';
import type { ConcernContext } from '@janus/core';
import { config } from '../config';

// ── RSS parsing helpers ───────────────────────────────────────────

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
}

function extractCdata(text: string): string {
  const match = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return match ? match[1].trim() : text.trim();
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  caseId?: string;
  enclosureUrl?: string;
  categories: string[];
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1];
    const get = (tag: string): string => {
      const m = content.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? extractCdata(m[1]) : '';
    };

    const categories: string[] = [];
    const catRegex = /<category[^>]*>([\s\S]*?)<\/category>/g;
    let catMatch: RegExpExecArray | null;
    while ((catMatch = catRegex.exec(content)) !== null) {
      categories.push(extractCdata(catMatch[1]));
    }

    const enclosureMatch = content.match(/<enclosure[^>]+url="([^"]+)"/);

    items.push({
      title: get('title'),
      link: get('link'),
      description: get('description'),
      pubDate: get('pubDate'),
      caseId: get('pp:caseid') || undefined,
      enclosureUrl: enclosureMatch?.[1],
      categories,
    });
  }

  return items;
}

// ── Handler ───────────────────────────────────────────────────────

handler('calgary-news-sync', async (ctx: ConcernContext) => {
  const dispatch = ctx._dispatch!;
  const feedUrl = config.connectors?.news?.feedUrl;
  if (!feedUrl) {
    console.log('[calgary-news] No feed URL configured, skipping');
    return;
  }

  let xml: string;
  try {
    const res = await fetch(feedUrl);
    xml = await res.text();
  } catch (err) {
    console.error('[calgary-news] Fetch failed:', err);
    return;
  }

  const items = parseRssItems(xml);
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recentItems = items.filter(item => {
    const pubDate = new Date(item.pubDate).getTime();
    return pubDate > ninetyDaysAgo;
  });

  console.log(`[calgary-news] Parsed ${items.length} items, ${recentItems.length} within 90 days`);

  for (const item of recentItems) {
    const externalId = item.caseId || item.link;
    if (!externalId) continue;

    const mapped: Record<string, unknown> = {
      title: item.title,
      summary: truncate(stripHtml(item.description), 200),
      body: item.description,
      sourceUrl: item.link,
      source: 'city-of-calgary',
      imageUrl: item.enclosureUrl || undefined,
      categories: item.categories.join(', '),
      publishedAt: new Date(item.pubDate).toISOString(),
      externalId,
      lastSyncedAt: new Date().toISOString(),
    };

    try {
      const existing = await dispatch('news_item', 'read', {
        where: { externalId },
        limit: 1,
      }, SYSTEM);
      const records = (existing as { data?: { records?: Array<{ id: string }> } })?.data?.records;

      if (records && records.length > 0) {
        await dispatch('news_item', 'update', { id: records[0].id, ...mapped }, SYSTEM);
      } else {
        await dispatch('news_item', 'create', mapped, SYSTEM);
      }
    } catch (err) {
      console.error(`[calgary-news] Error syncing ${externalId}:`, err);
    }
  }
}, 'Sync City of Calgary newsroom RSS feed');
