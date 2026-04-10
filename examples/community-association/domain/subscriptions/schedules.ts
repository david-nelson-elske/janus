/**
 * Cron-based schedules — membership expiry, session ticket issuance, news sync.
 *
 * Note: DMap connector schedules are defined in connectors/dmap.ts alongside
 * their Singleton entities and sync actions (proper connector pattern).
 */
import { subscribe, handler, SYSTEM } from '@janus/core';
import type { ConcernContext, ReadPage, ExecutionHandler } from '@janus/core';
import { membership, session_ticket } from '../entities';

// ── News connector (still uses simple handler pattern for now) ────
import '../../connectors/news';
import { define, participate } from '@janus/core';
import { Str, Json, Enum, Singleton } from '@janus/vocabulary';

export const news_connector = define('news_connector', {
  schema: {
    endpoint: Str({ required: true }),
    checkpoint: Json(),
    connectorStatus: Enum(['active', 'paused', 'error']),
  },
  storage: Singleton({
    defaults: {
      endpoint: 'https://newsroom.calgary.ca/tagfeed/en/tags/city__news,feature',
      connectorStatus: 'active',
    },
  }),
  description: 'City news RSS connector config',
});

export const newsConnectorParticipation = participate(news_connector, {
  actions: {
    sync: {
      kind: 'effect',
      handler: async (ctx) => {
        // Delegate to the registered handler
        const { resolveHandler } = await import('@janus/core');
        const entry = resolveHandler('calgary-news-sync');
        if (entry) await entry.fn(ctx);
      },
      description: 'Sync city news from RSS feed',
    },
  },
});

export const newsSchedule = subscribe(news_connector, [
  {
    cron: '0 8,14 * * *',
    handler: 'dispatch-adapter',
    config: { entity: 'news_connector', action: 'sync' },
    tracked: true,
    failure: 'retry',
    retry: { max: 3, backoff: 'exponential', initialDelay: 5000 },
  },
]);

// ── Membership expiry check ───────────────────────────────────────

handler('membership-expiry-check', async (ctx: ConcernContext) => {
  const dispatch = ctx._dispatch!;
  const now = new Date().toISOString();

  const result = await dispatch('membership', 'read', {
    where: { status: 'active' },
    limit: 500,
  }, SYSTEM);
  const records = ((result as { data?: { records?: Array<Record<string, unknown>> } })?.data?.records) ?? [];

  let expired = 0;
  for (const record of records) {
    const expiresAt = record.expiresAt as string | undefined;
    if (expiresAt && expiresAt < now) {
      try {
        await dispatch('membership', 'update:expired', { id: record.id as string }, SYSTEM);
        expired++;
      } catch (err) {
        console.error(`[membership-expiry] Failed to expire ${record.id}:`, err);
      }
    }
  }

  if (expired > 0) {
    console.log(`[membership-expiry] Expired ${expired} memberships`);
  }
}, 'Check and expire past-due memberships');

export const membershipExpirySchedule = subscribe(membership, [
  {
    cron: '0 8 * * *',
    handler: 'membership-expiry-check',
    config: {},
    failure: 'retry',
    retry: { max: 3, backoff: 'exponential', initialDelay: 5000 },
  },
]);

// ── Session ticket issuance ───────────────────────────────────────

handler('session-ticket-issuance', async (ctx: ConcernContext) => {
  const dispatch = ctx._dispatch!;

  const regResult = await dispatch('registration', 'read', {
    where: { status: 'confirmed' },
    limit: 1000,
  }, SYSTEM);
  const registrations = ((regResult as { data?: { records?: Array<Record<string, unknown>> } })?.data?.records) ?? [];

  let issued = 0;
  for (const reg of registrations) {
    const seriesId = reg.seriesId as string;
    const regId = reg.id as string;

    const sessionResult = await dispatch('session', 'read', {
      where: { seriesId, status: 'scheduled' },
      limit: 100,
    }, SYSTEM);
    const sessions = ((sessionResult as { data?: { records?: Array<Record<string, unknown>> } })?.data?.records) ?? [];

    for (const session of sessions) {
      const sessionId = session.id as string;

      const ticketResult = await dispatch('session_ticket', 'read', {
        where: { registrationId: regId, sessionId },
        limit: 1,
      }, SYSTEM);
      const existingTickets = ((ticketResult as { data?: { records?: unknown[] } })?.data?.records) ?? [];

      if (existingTickets.length === 0) {
        try {
          await dispatch('session_ticket', 'create', {
            registrationId: regId,
            sessionId,
          }, SYSTEM);
          issued++;
        } catch (err) {
          console.error(`[session-ticket] Failed to issue for reg=${regId} session=${sessionId}:`, err);
        }
      }
    }
  }

  if (issued > 0) {
    console.log(`[session-ticket] Issued ${issued} tickets`);
  }
}, 'Issue session tickets for confirmed registrations');

export const sessionTicketSchedule = subscribe(session_ticket, [
  {
    cron: '* * * * *',
    handler: 'session-ticket-issuance',
    config: {},
    failure: 'log',
  },
]);
