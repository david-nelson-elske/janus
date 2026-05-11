/**
 * Channel runtime — in-process publish/subscribe broker for declared
 * channels. Validates payloads + scope against declarations, fans out
 * to in-process subscribers, and emits to bridge sinks (SSE, agent)
 * registered via {@link registerBridgeSink}.
 *
 * Per `.planning/CHANNEL-DECLARATIONS.md` §6–§7. v1.5 is in-process —
 * a single Node/Bun process, no cross-process pubsub. Multi-process
 * deployments will need a Redis adapter; out of scope.
 */

import { valueMatchesType } from './declare';
import type {
  ChannelDeclaration,
  PayloadOf,
  ScopeOf,
} from './types';
import { lookupChannel, type ChannelRegistry } from './registry';

// ── Public types ──────────────────────────────────────────────────

export interface ChannelEvent<D extends ChannelDeclaration = ChannelDeclaration> {
  readonly channel: D['name'];
  readonly payload: PayloadOf<D>;
  readonly scope: ScopeOf<D>;
  /** Actor that published, free-form in v1.5; M5 will type-narrow. */
  readonly actor: string;
  /** ms since epoch. */
  readonly ts: number;
}

export type ChannelHandler<D extends ChannelDeclaration = ChannelDeclaration> = (
  event: ChannelEvent<D>,
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface PublishOptions<D extends ChannelDeclaration> {
  readonly scope: ScopeOf<D>;
  readonly payload: PayloadOf<D>;
  /** Free-form actor name; defaults to 'system'. */
  readonly actor?: string;
}

export interface SubscribeOptions<D extends ChannelDeclaration> {
  /**
   * Scope filter. Subscribers receive only events whose scope keys
   * match. An omitted key means "any value." An empty object means
   * "any event on this channel".
   */
  readonly scope: Partial<ScopeOf<D>>;
  readonly handler: ChannelHandler<D>;
}

/**
 * Bridge sink — a cross-process forwarder (SSE, WebSocket, agent
 * runtime). The runtime calls every registered sink for every publish
 * that survives validation; the sink decides whether to forward (e.g.
 * the SSE sink filters by connection subscriptions).
 */
export type BridgeSink = (event: ChannelEvent) => void;

// ── Broker shape ──────────────────────────────────────────────────

export interface ChannelBroker {
  readonly registry: ChannelRegistry;

  publish<D extends ChannelDeclaration>(
    decl: D,
    opts: PublishOptions<D>,
  ): void;

  subscribe<D extends ChannelDeclaration>(
    decl: D,
    opts: SubscribeOptions<D>,
  ): Unsubscribe;

  registerBridgeSink(sink: BridgeSink): Unsubscribe;

  /**
   * Persistence hook — invoked for `logged` / `sampled` channels.
   * Apps register a sink here (writes to interaction_event entity).
   * Optional: a broker with no persistence sink simply drops logged
   * events at the persistence step but still fans them out.
   */
  setPersistenceSink(sink: ((event: ChannelEvent) => void | Promise<void>) | null): void;
}

// ── Broker construction ───────────────────────────────────────────

interface SubscriberEntry {
  readonly scope: Partial<Record<string, unknown>>;
  readonly handler: ChannelHandler<ChannelDeclaration>;
}

export function createChannelBroker(registry: ChannelRegistry): ChannelBroker {
  const subscribers = new Map<string, Set<SubscriberEntry>>();
  const sinks = new Set<BridgeSink>();
  let persistenceSink: ((event: ChannelEvent) => void | Promise<void>) | null = null;

  function getSubs(channelName: string): Set<SubscriberEntry> {
    let set = subscribers.get(channelName);
    if (!set) {
      set = new Set();
      subscribers.set(channelName, set);
    }
    return set;
  }

  function scopeMatches(
    subscriberScope: Partial<Record<string, unknown>>,
    publishScope: Readonly<Record<string, unknown>>,
  ): boolean {
    for (const [key, want] of Object.entries(subscriberScope)) {
      if (want === undefined) continue;
      // Coerce both to string for matching — IDs are sometimes typed as numbers in
      // edge cases. Spec §12 "scope coercion" — coerce with a dev warning.
      const have = publishScope[key];
      if (String(have) !== String(want)) return false;
    }
    return true;
  }

  return {
    registry,

    publish<D extends ChannelDeclaration>(decl: D, opts: PublishOptions<D>) {
      lookupChannel(registry, decl.name);

      validatePublish(decl, opts);

      const event: ChannelEvent<D> = {
        channel: decl.name,
        payload: opts.payload,
        scope: opts.scope,
        actor: opts.actor ?? 'system',
        ts: Date.now(),
      };

      // Persistence first so logged-channel writes precede fan-out;
      // a synchronous downstream subscriber observing state should
      // see the persisted row (though we don't currently await).
      if (decl.persist !== 'transient' && persistenceSink) {
        const shouldPersist = decl.persist === 'logged' || sampleHit(decl.sampleRate);
        if (shouldPersist) {
          try {
            void persistenceSink(event as ChannelEvent);
          } catch (err) {
            // Dev visibility, not a thrown error — a failed log row
            // must not break the publish.
            console.error(`[channels] persistence sink threw for "${decl.name}"`, err);
          }
        }
      }

      // In-process subscribers.
      const subs = subscribers.get(decl.name);
      if (subs) {
        for (const entry of subs) {
          if (!scopeMatches(entry.scope, event.scope)) continue;
          try {
            void entry.handler(event as ChannelEvent<ChannelDeclaration>);
          } catch (err) {
            console.error(`[channels] subscriber threw for "${decl.name}"`, err);
          }
        }
      }

      // Bridge sinks (SSE, agent).
      for (const sink of sinks) {
        try {
          sink(event as ChannelEvent);
        } catch (err) {
          console.error(`[channels] bridge sink threw for "${decl.name}"`, err);
        }
      }
    },

    subscribe<D extends ChannelDeclaration>(decl: D, opts: SubscribeOptions<D>): Unsubscribe {
      lookupChannel(registry, decl.name);

      // Validate scope keys against the declaration.
      for (const key of Object.keys(opts.scope)) {
        if (!(key in decl.scope)) {
          throw new Error(
            `[channels] subscribe("${decl.name}") — unknown scope key "${key}"`,
          );
        }
      }

      const entry: SubscriberEntry = {
        scope: opts.scope as Partial<Record<string, unknown>>,
        handler: opts.handler as ChannelHandler<ChannelDeclaration>,
      };
      const set = getSubs(decl.name);
      set.add(entry);
      return () => {
        set.delete(entry);
        if (set.size === 0) subscribers.delete(decl.name);
      };
    },

    registerBridgeSink(sink: BridgeSink): Unsubscribe {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },

    setPersistenceSink(sink) {
      persistenceSink = sink;
    },
  };
}

function sampleHit(rate: number | undefined): boolean {
  if (!rate || rate <= 1) return true;
  return Math.floor(Math.random() * rate) === 0;
}

function validatePublish<D extends ChannelDeclaration>(decl: D, opts: PublishOptions<D>): void {
  // Scope must contain every declared scope key.
  for (const [key, type] of Object.entries(decl.scope)) {
    const value = (opts.scope as Record<string, unknown>)[key];
    if (value === undefined || value === null) {
      throw new Error(
        `[channels] publish("${decl.name}") — missing scope key "${key}"`,
      );
    }
    if (!valueMatchesType(value, type)) {
      throw new Error(
        `[channels] publish("${decl.name}") — scope key "${key}" has wrong type (expected ${type})`,
      );
    }
  }

  // Payload — required keys must be present and well-typed; optional
  // keys, if present, must match.
  for (const [key, type] of Object.entries(decl.payload)) {
    const isOptional = String(type).endsWith('?');
    const value = (opts.payload as Record<string, unknown>)[key];
    if (value === undefined || value === null) {
      if (isOptional) continue;
      throw new Error(
        `[channels] publish("${decl.name}") — missing required payload key "${key}"`,
      );
    }
    if (!valueMatchesType(value, type)) {
      throw new Error(
        `[channels] publish("${decl.name}") — payload key "${key}" has wrong type (expected ${type})`,
      );
    }
  }

  // Extra payload keys are dropped with a dev warning (spec §6 "what the publish runtime does").
  const declaredKeys = new Set(Object.keys(decl.payload));
  for (const key of Object.keys(opts.payload)) {
    if (!declaredKeys.has(key)) {
      console.warn(
        `[channels] publish("${decl.name}") — extra payload key "${key}" not declared (dropped)`,
      );
    }
  }
}

// ── Default broker (module-level, lazy) ─────────────────────────

let defaultBroker: ChannelBroker | null = null;

/**
 * Initialize the default broker exactly once with the app's channel
 * registry. Idempotent only if the same registry is passed; calling
 * with a different registry throws.
 */
export function initChannelBroker(registry: ChannelRegistry): ChannelBroker {
  if (defaultBroker) {
    if (defaultBroker.registry !== registry) {
      throw new Error(
        `[channels] initChannelBroker called twice with different registries`,
      );
    }
    return defaultBroker;
  }
  defaultBroker = createChannelBroker(registry);
  return defaultBroker;
}

/** Access the default broker. Throws if {@link initChannelBroker} was not called. */
export function getChannelBroker(): ChannelBroker {
  if (!defaultBroker) {
    throw new Error(
      `[channels] getChannelBroker() called before initChannelBroker()`,
    );
  }
  return defaultBroker;
}

/** For tests: reset the module-level singleton. */
export function _resetDefaultBrokerForTests(): void {
  defaultBroker = null;
}

// ── Convenience function bindings against the default broker ─────

export function publish<D extends ChannelDeclaration>(
  decl: D,
  opts: PublishOptions<D>,
): void {
  getChannelBroker().publish(decl, opts);
}

export function subscribe<D extends ChannelDeclaration>(
  decl: D,
  opts: SubscribeOptions<D>,
): Unsubscribe {
  return getChannelBroker().subscribe(decl, opts);
}
