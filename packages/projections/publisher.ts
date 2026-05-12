/**
 * Diff publisher — long-lived process that watches the pipeline broker
 * for entity notifications, recomposes affected projections for each
 * active scope, computes a JSON Patch against the prior cached view,
 * and `publish()`es the patch on the projection's declared channel.
 *
 * Per `.planning/PROJECTION-DECLARATIONS.md` §9.
 *
 * Phase 0 scope:
 *   - In-process registry of active `(projection, scope)` pairs.
 *     Callers explicitly `watch(decl, opts)` to activate a scope; the
 *     spec's "scopes with at least one live channel subscriber"
 *     optimization is deferred until the channel broker exposes a
 *     "who's listening" API.
 *   - Selector-touched entity index. A notify on entity X wakes only
 *     the projections whose selector tree references X.
 *   - 50 ms debounce per `(projection, scopeKey)` so a transaction
 *     bursting multiple notifies fans out one diff.
 *   - On recompose failure: publish a `resync` event on the diff
 *     channel and log the error. Never crashes the broker.
 */

import type { Broker, BrokerNotification, Unsubscribe } from '@janus/pipeline';
import type { ChannelBroker, ScopeOf } from '@janus/channels';
import type { EntityStore } from '@janus/core';
import { compose } from './compose';
import { diffComposed, type JsonPatch } from './patch';
import type {
  ComposeContext,
  ComposeOptions,
  ComposedValue,
  ProjectionDeclaration,
  RelationSpec,
  SelectorTree,
} from './types';

// ── Public API ───────────────────────────────────────────────────

export interface DiffPublisherConfig {
  readonly store: EntityStore;
  readonly broker: Broker;
  readonly channelBroker: ChannelBroker;
  /** Per-scope debounce in ms. Defaults to 50 ms per spec §9. */
  readonly debounceMs?: number;
}

export interface WatchHandle {
  /** Initial composed view as of `watch()`. */
  readonly view: ComposedValue;
  /** Monotonic version per `(projection, scope)`. */
  readonly version: number;
  /** Stop watching this scope. Cancels pending debounces. */
  readonly stop: () => void;
}

export interface DiffPublisher {
  watch(
    decl: ProjectionDeclaration,
    opts: ComposeOptions,
  ): Promise<WatchHandle>;

  /** Stop all watches and unsubscribe from the broker. */
  shutdown(): void;
}

/** Build the publisher and start listening to the broker. */
export function createDiffPublisher(config: DiffPublisherConfig): DiffPublisher {
  const debounceMs = config.debounceMs ?? 50;

  interface Subscription {
    readonly decl: ProjectionDeclaration;
    readonly scopeKey: string;
    readonly opts: ComposeOptions;
    readonly entities: ReadonlySet<string>;
    cachedView: ComposedValue;
    version: number;
    debounceTimer: ReturnType<typeof setTimeout> | null;
  }

  // scopeKey → Subscription
  const subscriptions = new Map<string, Subscription>();
  // entity name → set of scopeKey
  const byEntity = new Map<string, Set<string>>();

  const brokerUnsubscribe: Unsubscribe = config.broker.onNotify(handleNotify);

  function handleNotify(notification: BrokerNotification): void {
    const scopes = byEntity.get(notification.entity);
    if (!scopes || scopes.size === 0) return;
    for (const key of scopes) {
      const sub = subscriptions.get(key);
      if (!sub) continue;
      scheduleRecompose(sub);
    }
  }

  function scheduleRecompose(sub: Subscription): void {
    if (sub.debounceTimer) return;
    sub.debounceTimer = setTimeout(() => {
      sub.debounceTimer = null;
      void recomposeAndPublish(sub);
    }, debounceMs);
  }

  async function recomposeAndPublish(sub: Subscription): Promise<void> {
    let next: ComposedValue;
    try {
      next = await compose(config.store, sub.decl, sub.opts);
    } catch (err) {
      // Recompose failed (entity deleted mid-compose, store hiccup, …)
      // Spec §9: emit a `resync` and log; subscribers refetch via
      // their own compose() and resync.
      console.error(`[projections] recompose failed for "${sub.decl.name}"`, err);
      emitResync(sub);
      return;
    }

    const patch = diffComposed(sub.cachedView, next);
    if (patch.length === 0) return;

    const fromVersion = sub.version;
    const toVersion = fromVersion + 1;
    sub.cachedView = next;
    sub.version = toVersion;

    if (sub.decl.diffChannel) {
      publishDiff(sub, fromVersion, toVersion, patch);
    }
  }

  function publishDiff(
    sub: Subscription,
    fromVersion: number,
    toVersion: number,
    patch: JsonPatch,
  ): void {
    const channel = sub.decl.diffChannel;
    if (!channel) return;
    const scope = deriveChannelScope(channel, sub.opts.params ?? {});
    if (!scope) {
      console.error(
        `[projections] cannot derive channel scope for "${sub.decl.name}" — missing params for channel "${channel.name}"`,
      );
      return;
    }
    const payload: Record<string, unknown> = {
      ...scope,
      projection: sub.decl.name,
      fromVersion,
      toVersion,
      patch: patch as unknown,
    };
    try {
      config.channelBroker.publish(channel, {
        scope: scope as ScopeOf<typeof channel>,
        // The channel's payload type may differ; we ship the diff under
        // a `projection` envelope plus the channel's required keys.
        // Channel runtime drops unknown keys with a dev warning.
        payload: payload as never,
        actor: 'projection-publisher',
      });
    } catch (err) {
      console.error(
        `[projections] publish on "${channel.name}" failed for "${sub.decl.name}"`,
        err,
      );
    }
  }

  function emitResync(sub: Subscription): void {
    const channel = sub.decl.diffChannel;
    if (!channel) return;
    const scope = deriveChannelScope(channel, sub.opts.params ?? {});
    if (!scope) return;
    try {
      config.channelBroker.publish(channel, {
        scope: scope as ScopeOf<typeof channel>,
        payload: {
          ...scope,
          projection: sub.decl.name,
          resync: true,
        } as never,
        actor: 'projection-publisher',
      });
    } catch (err) {
      console.error(
        `[projections] resync publish on "${channel.name}" failed`,
        err,
      );
    }
  }

  function deriveChannelScope(
    channel: ProjectionDeclaration['diffChannel'] & {},
    params: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> | null {
    const scope: Record<string, unknown> = {};
    for (const key of Object.keys(channel.scope)) {
      const value = params[key];
      if (value === undefined || value === null) return null;
      scope[key] = value;
    }
    return scope;
  }

  function indexByEntities(key: string, entities: ReadonlySet<string>): void {
    for (const entity of entities) {
      let set = byEntity.get(entity);
      if (!set) {
        set = new Set();
        byEntity.set(entity, set);
      }
      set.add(key);
    }
  }

  function unindexByEntities(key: string, entities: ReadonlySet<string>): void {
    for (const entity of entities) {
      const set = byEntity.get(entity);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) byEntity.delete(entity);
    }
  }

  function deriveScopeKey(
    decl: ProjectionDeclaration,
    opts: ComposeOptions,
  ): string {
    // Stable, role-aware key: params canonicalized + actorRole. Other
    // ctx differences don't affect the composed shape's identity.
    const params = canonicalParams(opts.params ?? {});
    const role = (opts.ctx as ComposeContext | undefined)?.actorRole ?? '';
    return `${decl.name}::${role}::${params}`;
  }

  return {
    async watch(decl, opts): Promise<WatchHandle> {
      const key = deriveScopeKey(decl, opts);
      const existing = subscriptions.get(key);
      if (existing) {
        // Same projection + same params + same role already watched —
        // share the cached view; callers each get their own stop().
        // Phase 0 doesn't reference-count: stopping any handle removes
        // the subscription. Callers must own the (projection, params)
        // pair uniquely or call watch() each loader cycle.
      }

      const entities = collectSelectorEntities(decl.selector);
      const initialView = await compose(config.store, decl, opts);

      const sub: Subscription = {
        decl,
        scopeKey: key,
        opts,
        entities,
        cachedView: initialView,
        version: 0,
        debounceTimer: null,
      };
      subscriptions.set(key, sub);
      indexByEntities(key, entities);

      return {
        view: initialView,
        version: 0,
        stop: () => {
          const current = subscriptions.get(key);
          if (!current) return;
          if (current.debounceTimer) {
            clearTimeout(current.debounceTimer);
          }
          subscriptions.delete(key);
          unindexByEntities(key, current.entities);
        },
      };
    },

    shutdown(): void {
      brokerUnsubscribe();
      for (const sub of subscriptions.values()) {
        if (sub.debounceTimer) clearTimeout(sub.debounceTimer);
      }
      subscriptions.clear();
      byEntity.clear();
    },
  };
}

// ── Selector entity collection ──────────────────────────────────

/**
 * Collect every entity name referenced by a selector tree. Exposed for
 * tests and the publisher's broker-notification index.
 */
export function collectSelectorEntities(selector: SelectorTree): ReadonlySet<string> {
  const out = new Set<string>();
  out.add(selector.root.entity);
  if (selector.relations) walkEntities(selector.relations, out);
  return out;
}

function walkEntities(
  relations: Readonly<Record<string, RelationSpec>>,
  out: Set<string>,
): void {
  for (const rel of Object.values(relations)) {
    out.add(rel.from);
    if (rel.relations) walkEntities(rel.relations, out);
  }
}

// ── Param canonicalization ──────────────────────────────────────

function canonicalParams(params: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}=${String(params[k])}`);
  }
  return parts.join('&');
}
