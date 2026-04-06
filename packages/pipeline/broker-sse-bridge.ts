/**
 * Broker → SSE bridge.
 *
 * Listens to all broker notifications and pushes entity events to matching
 * SSE connections via the connection manager. This replaces the full
 * stream-pusher subscription handler for M8-render (simpler, direct wiring).
 *
 * The subscription-based stream-pusher is still available for per-entity
 * subscription wiring, but this bridge handles the common case of "push
 * all entity mutations to matching SSE clients."
 */

import type { Broker, Unsubscribe } from './broker';
import type { ConnectionManager } from './connection-manager';
import type { EntityStore } from '@janus/core';

export interface BrokerSseBridgeConfig {
  readonly broker: Broker;
  readonly connectionManager: ConnectionManager;
  readonly store: EntityStore;
}

export function startBrokerSseBridge(config: BrokerSseBridgeConfig): Unsubscribe {
  const { broker, connectionManager, store } = config;

  return broker.onNotify(async (notification) => {
    const { entity, entityId, descriptor } = notification;
    if (!entityId) return;

    // Skip framework entities (execution_log, etc.)
    // Only push consumer entity events
    if (entity === 'execution_log') return;

    if (descriptor === 'deleted') {
      connectionManager.pushToSubscribers(entity, entityId, {
        type: 'entity:deleted',
        entity,
        id: entityId,
        timestamp: Date.now(),
      });
      return;
    }

    // Read current record for the push payload
    try {
      const result = await store.read(entity, { id: entityId });
      if (!result || !('id' in (result as any))) return;

      connectionManager.pushToSubscribers(entity, entityId, {
        type: 'entity:changed',
        entity,
        id: entityId,
        operation: descriptor,
        record: result,
        timestamp: Date.now(),
      });
    } catch {
      // Record might be gone, skip
    }
  });
}
