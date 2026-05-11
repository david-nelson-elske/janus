/**
 * JanusController — base class every concrete controller extends.
 *
 * Extends Stimulus's `Controller` and adds Janus-specific affordances:
 * channel subscribe/publish, cross-controller `invoke()`, operation
 * dispatch, and access to the in-page event bus.
 *
 * Per spec §7. The base class is intentionally thin: most of the work
 * happens in the manifest emitter + client bootstrap.
 *
 * v1 status: subscribe/publish/invoke/dispatch are stubs that warn.
 * Spec 2 (channels) and spec 5 (capabilities) will replace the stubs
 * with real implementations.
 */

import { Controller } from '@hotwired/stimulus';
import { getBus, type JanusBus, type BusUnsubscribe } from './bus';
import { registerChannelHandler } from '@janus/channels/client';
import { findControllerSubscriptions } from './manifest-lookup';

// ── Channel event shape (mirrors @janus/channels) ─────────────────

export interface ChannelEvent {
  readonly channel: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly ts: number;
}

export type Unsubscribe = () => void;

// ── Base class ────────────────────────────────────────────────────

export abstract class JanusController extends Controller<HTMLElement> {
  // Subscriptions opened by the controller during `connect()`. Closed
  // automatically in `disconnect()`. Subclasses use `this.subscribe()`;
  // the unsubscribe is tracked here so subclasses don't have to.
  #subscriptions: Unsubscribe[] = [];

  // ── Lifecycle ─────────────────────────────────────────────

  override connect(): void {
    super.connect();
    this.janusConnect?.();
  }

  override disconnect(): void {
    for (const unsub of this.#subscriptions) {
      try {
        unsub();
      } catch (err) {
        console.error('[JanusController] subscription cleanup threw', err);
      }
    }
    this.#subscriptions = [];
    this.janusDisconnect?.();
    super.disconnect();
  }

  /**
   * Optional lifecycle hook called after `connect()`. Subclasses
   * override instead of `connect()` so the base class can manage
   * cross-cutting setup (subscription tracking) without requiring
   * `super.connect()` discipline at every override site.
   */
  protected janusConnect?(): void;

  /** Mirror of {@link janusConnect}, called before `disconnect()`. */
  protected janusDisconnect?(): void;

  // ── Channels (stubs — spec 2) ─────────────────────────────

  /**
   * Subscribe to a server channel. The returned unsubscribe is tracked
   * automatically and called on `disconnect()`.
   *
   * v1.5: resolved against the page manifest's `subscriptions` list
   * for this controller — the scope passed to the SSE bridge is the
   * one declared at SSR time. Calling `subscribe()` with a channel
   * that is not in the manifest logs a warning in dev and is a no-op.
   */
  protected subscribe(channel: string, handler: (event: ChannelEvent) => void): Unsubscribe {
    const scopes = findControllerSubscriptions(this.identifier, channel);

    if (scopes.length === 0) {
      if (this.#isDev()) {
        console.warn(
          `[JanusController:${this.identifier}] subscribe("${channel}") — channel not in manifest subscriptions`,
        );
      }
      const unsub: Unsubscribe = () => {};
      this.#subscriptions.push(unsub);
      return unsub;
    }

    // The manifest may list multiple subscriptions for the same channel
    // under one controller (different scopes). Register one client
    // handler per scope so the SSE filter is precise.
    const unsubs = scopes.map((scope) =>
      registerChannelHandler(channel, scope, (event) => {
        handler({
          channel: event.channel,
          payload: event.payload,
          scope: event.scope,
          ts: event.ts,
        });
      }),
    );
    const unsub: Unsubscribe = () => {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* tolerated */
        }
      }
    };
    this.#subscriptions.push(unsub);
    return unsub;
  }

  /**
   * Publish a payload to a server channel from the client.
   *
   * Client-originated channel publishes are uncommon — most publishes
   * happen server-side from operation handlers. v1.5 keeps this as a
   * dev-warning stub; M5 (capability graph) will define the wire path
   * for client → server channel publishes with per-actor ACLs.
   */
  protected publish(channel: string, payload: unknown): void {
    void payload;
    if (this.#isDev()) {
      console.warn(
        `[JanusController:${this.identifier}] publish("${channel}") — client-originated channel publish not wired in v1.5`,
      );
    }
  }

  // ── Cross-controller invocation (stub — wired by client bootstrap) ──

  /**
   * Invoke a named action on another mounted controller. Resolved by
   * the page-wide controller registry maintained by the client
   * bootstrap. Capability-checked when the caller is the agent runtime.
   *
   * v1: stub. The client bootstrap will overwrite `globalThis.__janusInvoke`
   * with the real implementation once installed.
   */
  protected async invoke(
    controller: string,
    action: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const fn = (globalThis as { __janusInvoke?: typeof JanusController.prototype.invoke }).__janusInvoke;
    if (fn) {
      return fn.call(this, controller, action, params);
    }
    if (this.#isDev()) {
      console.warn(
        `[JanusController:${this.identifier}] invoke("${controller}#${action}") — no bootstrap installed`,
      );
    }
  }

  // ── Operation dispatch (stub) ─────────────────────────────

  /**
   * Dispatch an operation against the server. Wraps the existing
   * fetch-based dispatch path the app already uses for entity
   * mutations.
   *
   * Named `dispatchOp` (not plain `dispatch`) because Stimulus's
   * `Controller` already defines `dispatch()` for emitting custom DOM
   * events — a useful affordance we don't want to clobber. The spec
   * doc calls this `dispatch`; rename was made here at implementation
   * time.
   *
   * v1: stub. Spec-relative consumers should still call their app's
   * existing dispatch helper directly; this method is the eventual
   * single chokepoint.
   */
  protected async dispatchOp<T = unknown>(
    op: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    void input;
    if (this.#isDev()) {
      console.warn(
        `[JanusController:${this.identifier}] dispatchOp("${op}") — operation dispatch not yet wired (spec 5)`,
      );
    }
    return undefined as T;
  }

  // ── Event bus ─────────────────────────────────────────────

  protected get bus(): JanusBus {
    return getBus();
  }

  /**
   * Convenience wrapper around `this.bus.subscribe()` that tracks the
   * unsubscribe so it fires automatically on `disconnect()`.
   */
  protected onBus(topic: string, handler: (payload: unknown) => void): BusUnsubscribe {
    const unsub = this.bus.subscribe(topic, handler);
    this.#subscriptions.push(unsub);
    return unsub;
  }

  // ── Helpers ───────────────────────────────────────────────

  #isDev(): boolean {
    return (
      typeof process !== 'undefined' && (process as { env?: { NODE_ENV?: string } }).env?.NODE_ENV !== 'production'
    );
  }
}
