/**
 * Channel SSE bridge — server-side.
 *
 * Exposes a page-wide SSE stream that multiplexes all the page's
 * subscribed channels by event name. The client opens one stream per
 * page and the bootstrap dispatches incoming events to the right
 * controller handler.
 *
 * Per `.planning/CHANNEL-DECLARATIONS.md` §8 "Wire format".
 *
 * Apps mount this via {@link handleChannelStream}, passing the
 * subscriber's identity + the subscription set parsed from the page
 * manifest (or from query string in v1.5).
 */

import type { ChannelBroker, ChannelEvent } from './runtime';

/** A single channel+scope tuple a connection is interested in. */
export interface SseSubscription {
  readonly channel: string;
  readonly scope: Readonly<Record<string, unknown>>;
}

export interface OpenStreamOptions {
  readonly broker: ChannelBroker;
  /** The connection's interest set. */
  readonly subscriptions: readonly SseSubscription[];
  /**
   * Optional identity used by an app to enforce per-user scope rules
   * (e.g. drop events whose scope's userId doesn't match). v1.5 just
   * records it; M5 will enforce.
   */
  readonly actor?: string;
  /**
   * AbortSignal that fires when the client disconnects. Required —
   * the bridge uses it to drop the bridge-sink registration.
   */
  readonly signal: AbortSignal;
  /**
   * Heartbeat interval in ms. Defaults to 25 000 (just under the
   * 30s timeout most edge proxies impose).
   */
  readonly heartbeatMs?: number;
}

/**
 * Open an SSE stream Response carrying matching channel events.
 *
 * The returned Response is suitable for return from a Hono / Fetch
 * handler. When the client disconnects (`signal` aborts), the bridge
 * sink and heartbeat are cleaned up.
 */
export function openChannelStream(opts: OpenStreamOptions): Response {
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const encoder = new TextEncoder();

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unregister: (() => void) | null = null;

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unregister) {
      unregister();
      unregister = null;
    }
    if (controller) {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
      controller = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;

      // Heartbeat keeps the connection alive through proxies.
      heartbeat = setInterval(() => {
        if (!controller) return;
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          cleanup();
        }
      }, heartbeatMs);

      // Initial probe so the client knows the stream is live.
      try {
        controller.enqueue(encoder.encode(`: connected\n\n`));
      } catch {
        cleanup();
        return;
      }

      // Register the bridge sink. The broker calls this for every
      // publish; we filter by the connection's declared interests.
      unregister = opts.broker.registerBridgeSink((event: ChannelEvent) => {
        if (!controller) return;
        if (!matchesAnySubscription(opts.subscriptions, event)) return;
        const frame = formatSseFrame(event);
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          cleanup();
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  opts.signal.addEventListener('abort', cleanup);

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}

function matchesAnySubscription(
  subs: readonly SseSubscription[],
  event: ChannelEvent,
): boolean {
  for (const sub of subs) {
    if (sub.channel !== event.channel) continue;
    if (scopeMatches(sub.scope, event.scope)) return true;
  }
  return false;
}

function scopeMatches(
  want: Readonly<Record<string, unknown>>,
  have: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, value] of Object.entries(want)) {
    if (value === undefined || value === null) continue;
    if (String(have[key]) !== String(value)) return false;
  }
  return true;
}

function formatSseFrame(event: ChannelEvent): string {
  const id = `${event.ts}-${Math.random().toString(36).slice(2, 8)}`;
  const data = JSON.stringify({ scope: event.scope, payload: event.payload, ts: event.ts });
  return `event: ${event.channel}\nid: ${id}\ndata: ${data}\n\n`;
}

// ── Subscription parsing ────────────────────────────────────────

/**
 * Parse the wire form of subscriptions used by the client bootstrap
 * when opening `/api/channels/stream`. Format (repeated `sub` param):
 *
 *   ?sub=decision-updated:decisionId=d_42
 *   ?sub=chat-message-posted:memberId=m_1&sub=...
 *
 * A `sub` value without `:` means whole-channel subscription with no
 * scope filter.
 */
export function parseSubscriptionsFromQuery(
  searchParams: URLSearchParams,
): readonly SseSubscription[] {
  const subs: SseSubscription[] = [];
  for (const raw of searchParams.getAll('sub')) {
    const colon = raw.indexOf(':');
    if (colon === -1) {
      subs.push({ channel: raw, scope: {} });
      continue;
    }
    const channel = raw.slice(0, colon);
    const rest = raw.slice(colon + 1);
    const scope: Record<string, unknown> = {};
    for (const pair of rest.split(',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      scope[key] = value;
    }
    subs.push({ channel, scope });
  }
  return subs;
}
