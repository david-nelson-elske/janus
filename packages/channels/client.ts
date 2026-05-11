/**
 * Channel client — browser-side helpers that connect a page to the
 * server's `/api/channels/stream` endpoint and dispatch events to
 * controller-registered handlers.
 *
 * Per `.planning/CHANNEL-DECLARATIONS.md` §7 + §8. The controller
 * client bootstrap calls {@link openClientStream} once it knows the
 * page manifest's subscriptions; controllers register handlers via
 * {@link registerChannelHandler} (typically wrapped by
 * `JanusController#subscribe()`).
 */

/** Browser-side subscription tuple. Mirrors the SSE-bridge wire form. */
export interface ClientSubscription {
  readonly channel: string;
  readonly scope: Readonly<Record<string, unknown>>;
}

export interface ClientChannelEvent {
  readonly channel: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly ts: number;
}

export type ClientHandler = (event: ClientChannelEvent) => void;
export type Unsubscribe = () => void;

interface HandlerEntry {
  readonly channel: string;
  /** Scope filter; an empty object matches any scope. */
  readonly scope: Readonly<Record<string, unknown>>;
  readonly handler: ClientHandler;
}

let eventSource: EventSource | null = null;
let openedFor: readonly ClientSubscription[] = [];
const handlers: Set<HandlerEntry> = new Set();
const attachedChannels = new Set<string>();

/** Path to the page-wide SSE endpoint. Apps override at bootstrap. */
let streamPath = '/api/channels/stream';

export function configureChannelClient(opts: { streamPath?: string }): void {
  if (opts.streamPath) streamPath = opts.streamPath;
}

/**
 * Open (or re-open) the SSE stream for the given subscription set.
 * Idempotent when called repeatedly with the same subscriptions.
 */
export function openClientStream(subs: readonly ClientSubscription[]): void {
  if (typeof EventSource === 'undefined') return;
  if (subs.length === 0) {
    closeClientStream();
    return;
  }

  if (eventSource && sameSubs(subs, openedFor)) return;

  closeClientStream();

  const url = new URL(streamPath, location.origin);
  for (const sub of subs) {
    url.searchParams.append('sub', encodeSubscription(sub));
  }

  eventSource = new EventSource(url.toString());
  openedFor = subs;

  // Pre-attach listeners for the channels we already have handlers for.
  for (const entry of handlers) {
    attachListenerOnce(entry.channel);
  }
}

export function closeClientStream(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  attachedChannels.clear();
  openedFor = [];
}

/**
 * Register a handler for events on `channel` whose scope matches the
 * provided filter. Returns an unsubscribe; the underlying SSE stream
 * is not closed on unsubscribe (it remains for the lifetime of the
 * page).
 */
export function registerChannelHandler(
  channel: string,
  scope: Readonly<Record<string, unknown>>,
  handler: ClientHandler,
): Unsubscribe {
  const entry: HandlerEntry = { channel, scope, handler };
  handlers.add(entry);
  if (eventSource) attachListenerOnce(channel);
  return () => {
    handlers.delete(entry);
  };
}

function attachListenerOnce(channel: string): void {
  if (!eventSource || attachedChannels.has(channel)) return;
  attachedChannels.add(channel);
  eventSource.addEventListener(channel, (ev) => {
    const me = ev as MessageEvent;
    let parsed: { scope?: unknown; payload?: unknown; ts?: unknown };
    try {
      parsed = JSON.parse(me.data) as typeof parsed;
    } catch {
      return;
    }
    const evt: ClientChannelEvent = {
      channel,
      scope: (parsed.scope as Record<string, unknown>) ?? {},
      payload: (parsed.payload as Record<string, unknown>) ?? {},
      ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
    };
    for (const entry of handlers) {
      if (entry.channel !== channel) continue;
      if (!scopeMatches(entry.scope, evt.scope)) continue;
      try {
        entry.handler(evt);
      } catch (err) {
        console.error(`[channels] client handler threw for "${channel}"`, err);
      }
    }
  });
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

function encodeSubscription(sub: ClientSubscription): string {
  const entries = Object.entries(sub.scope).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return sub.channel;
  const tail = entries.map(([k, v]) => `${k}=${String(v)}`).join(',');
  return `${sub.channel}:${tail}`;
}

function sameSubs(a: readonly ClientSubscription[], b: readonly ClientSubscription[]): boolean {
  if (a.length !== b.length) return false;
  const aEnc = a.map(encodeSubscription).sort();
  const bEnc = b.map(encodeSubscription).sort();
  return aEnc.every((v, i) => v === bEnc[i]);
}
