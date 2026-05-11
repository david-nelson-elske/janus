/**
 * In-page event bus — pub/sub for controller-to-controller messaging
 * that does not need to leave the browser.
 *
 * Per spec §10. Distinct from server channels by design: server
 * channels imply a network boundary, an ACL, and possibly persistence;
 * the bus has none of those. Unifying would force every local event to
 * pay channel-layer overhead for no gain.
 */

export type BusHandler = (payload: unknown) => void;
export type BusUnsubscribe = () => void;

export interface JanusBus {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, handler: BusHandler): BusUnsubscribe;
}

const SYM = '__janusBus' as const;

interface WindowWithBus {
  [SYM]?: JanusBus;
}

/**
 * Return the page-wide bus, lazily constructing it on first access.
 * Safe to call from server contexts — returns a no-op bus.
 */
export function getBus(): JanusBus {
  if (typeof window === 'undefined') return NOOP_BUS;
  const w = window as unknown as WindowWithBus;
  if (!w[SYM]) {
    const target = new EventTarget();
    w[SYM] = {
      publish(topic, payload) {
        target.dispatchEvent(new CustomEvent(topic, { detail: payload }));
      },
      subscribe(topic, handler) {
        const listener = (e: Event) => handler((e as CustomEvent).detail);
        target.addEventListener(topic, listener);
        return () => target.removeEventListener(topic, listener);
      },
    };
  }
  return w[SYM] as JanusBus;
}

const NOOP_BUS: JanusBus = {
  publish() {},
  subscribe() {
    return () => {};
  },
};
