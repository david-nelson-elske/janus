/**
 * Broker — in-process notification layer.
 *
 * STABLE — ported from packages/next/pipeline/broker.ts.
 * Carries routing metadata only (entity, entityId, descriptor kind).
 * Consumers subscribe to notifications and read from the store when woken up.
 *
 * UPDATE @ M7: Subscription processor listens to broker notifications
 * and fires matching subscriptions.
 */

export interface BrokerNotification {
  readonly entity: string;
  readonly entityId?: string;
  readonly descriptor: string;
  readonly correlationId: string;
}

export type NotifyListener = (notification: BrokerNotification) => void;

export interface NotifyFilter {
  readonly entity: string;
  readonly entityId?: string;
}

export type Unsubscribe = () => void;

export interface Broker {
  notify(notification: BrokerNotification): void;
  onNotify(listener: NotifyListener): Unsubscribe;
  onNotify(filter: NotifyFilter, listener: NotifyListener): Unsubscribe;
}

export function createBroker(): Broker {
  const global = new Set<NotifyListener>();
  const byEntity = new Map<string, Set<NotifyListener>>();
  const byRecord = new Map<string, Set<NotifyListener>>();

  return {
    notify(hint) {
      for (const listener of global) listener(hint);
      const entityListeners = byEntity.get(hint.entity);
      if (entityListeners) {
        for (const listener of entityListeners) listener(hint);
      }
      if (hint.entityId) {
        const key = `${hint.entity}:${hint.entityId}`;
        const recordListeners = byRecord.get(key);
        if (recordListeners) {
          for (const listener of recordListeners) listener(hint);
        }
      }
    },

    onNotify(...args: [NotifyListener] | [NotifyFilter, NotifyListener]): Unsubscribe {
      if (typeof args[0] === 'function') {
        const listener = args[0];
        global.add(listener);
        return () => global.delete(listener);
      }

      const filter = args[0] as NotifyFilter;
      const listener = args[1] as NotifyListener;

      if (filter.entityId) {
        const key = `${filter.entity}:${filter.entityId}`;
        let set = byRecord.get(key);
        if (!set) {
          set = new Set();
          byRecord.set(key, set);
        }
        set.add(listener);
        return () => {
          set!.delete(listener);
          if (set!.size === 0) byRecord.delete(key);
        };
      }

      let set = byEntity.get(filter.entity);
      if (!set) {
        set = new Set();
        byEntity.set(filter.entity, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) byEntity.delete(filter.entity);
      };
    },
  };
}
