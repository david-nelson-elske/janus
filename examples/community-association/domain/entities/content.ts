/**
 * Content entities: content, news_item
 *
 * Note: document and document_chunk are deferred (PDF chunking not yet in framework).
 */
import { define } from '@janus/core';
import {
  Str, DateTime, Url, Asset, Markdown, Slug, Mention,
  Public, Persistent,
} from '@janus/vocabulary';
import { contentLifecycle, newsItemLifecycle } from '../lifecycles';

// ── Content (announcements/blog) ──────────────────────────────────
export const content = define('content', {
  schema: Public({
    title: Str({ required: true, as: 'title' }),
    body: Markdown({ as: 'body' }),
    slug: Slug(),
    category: Str(),
    about: Mention({ allowed: ['committee', 'series', 'facility'] }),
    image: Asset({ accept: 'image/*', as: 'image' }),
    photos: Asset({ accept: 'image/*' }),
    document: Asset({ accept: 'application/pdf' }),
    publishedAt: DateTime({ as: 'timestamp' }),
    status: contentLifecycle,
  }),
  storage: Persistent(),
  description: 'Announcements, blog posts, and pages',
});

// ── News Item (synced from external source) ───────────────────────
export const news_item = define('news_item', {
  schema: Public({
    title: Str({ required: true, as: 'title' }),
    summary: Str({ as: 'summary' }),
    body: Markdown({ as: 'body' }),
    sourceUrl: Url(),
    source: Str({ as: 'subtitle' }),
    imageUrl: Url(),
    categories: Str(),
    publishedAt: DateTime({ required: true, as: 'timestamp' }),
    externalId: Str({ required: true, searchable: false }),
    lastSyncedAt: DateTime({ searchable: false }),
    status: newsItemLifecycle,
  }),
  storage: Persistent(),
  description: 'City news item synced from external RSS feed',
});
