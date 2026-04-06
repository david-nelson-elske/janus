/**
 * Tests for broker → SSE bridge.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { createBroker } from '../broker';
import { createConnectionManager } from '../connection-manager';
import { startBrokerSseBridge } from '../broker-sse-bridge';
import type { Broker } from '../broker';
import type { ConnectionManager, SseConnection } from '../connection-manager';
import type { EntityStore } from '@janus/core';

function mockStore(records: Record<string, Record<string, unknown>>): EntityStore {
  return {
    async read(_entity: string, params?: any) {
      if (params?.id) {
        const record = records[params.id];
        if (!record) throw new Error('Not found');
        return record;
      }
      return { records: Object.values(records), hasMore: false };
    },
    create: async () => ({} as any),
    update: async () => ({} as any),
    delete: async () => {},
    withTransaction: async (fn: any) => fn({} as any),
    initialize: async () => {},
  } as EntityStore;
}

function mockConnection(id: string, subscriptions: string[]): { conn: SseConnection; messages: string[] } {
  const messages: string[] = [];
  const conn: SseConnection = {
    id,
    userId: 'user1',
    controller: {
      enqueue: (chunk: string) => messages.push(chunk),
      close: () => {},
    },
    subscriptions: new Set(subscriptions),
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  return { conn, messages };
}

describe('BrokerSseBridge', () => {
  let broker: Broker;
  let manager: ConnectionManager;

  beforeEach(() => {
    broker = createBroker();
    manager = createConnectionManager();
  });

  test('pushes entity:changed to subscribed connections', async () => {
    const store = mockStore({ '1': { id: '1', title: 'Test', _version: 1 } });
    const { conn, messages } = mockConnection('c1', ['task']);
    manager.add(conn);

    const unsub = startBrokerSseBridge({ broker, connectionManager: manager, store });

    broker.notify({ entity: 'task', entityId: '1', descriptor: 'created', correlationId: 'corr-1' });

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 20));

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.parse(messages[0].replace('data: ', '').trim());
    expect(msg.type).toBe('entity:changed');
    expect(msg.entity).toBe('task');
    expect(msg.id).toBe('1');

    unsub();
  });

  test('pushes entity:deleted for delete events', async () => {
    const store = mockStore({});
    const { conn, messages } = mockConnection('c1', ['task']);
    manager.add(conn);

    const unsub = startBrokerSseBridge({ broker, connectionManager: manager, store });

    broker.notify({ entity: 'task', entityId: '1', descriptor: 'deleted', correlationId: 'corr-1' });

    await new Promise((r) => setTimeout(r, 20));

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const msg = JSON.parse(messages[0].replace('data: ', '').trim());
    expect(msg.type).toBe('entity:deleted');

    unsub();
  });

  test('skips notifications without entityId', async () => {
    const store = mockStore({});
    const { conn, messages } = mockConnection('c1', ['task']);
    manager.add(conn);

    const unsub = startBrokerSseBridge({ broker, connectionManager: manager, store });

    broker.notify({ entity: 'task', descriptor: 'created', correlationId: 'corr-1' });

    await new Promise((r) => setTimeout(r, 20));

    expect(messages).toHaveLength(0);

    unsub();
  });

  test('skips execution_log events', async () => {
    const store = mockStore({});
    const { conn, messages } = mockConnection('c1', ['execution_log']);
    manager.add(conn);

    const unsub = startBrokerSseBridge({ broker, connectionManager: manager, store });

    broker.notify({ entity: 'execution_log', entityId: '1', descriptor: 'created', correlationId: 'corr-1' });

    await new Promise((r) => setTimeout(r, 20));

    expect(messages).toHaveLength(0);

    unsub();
  });

  test('unsubscribe stops bridge', async () => {
    const store = mockStore({ '1': { id: '1', title: 'Test' } });
    const { conn, messages } = mockConnection('c1', ['task']);
    manager.add(conn);

    const unsub = startBrokerSseBridge({ broker, connectionManager: manager, store });
    unsub();

    broker.notify({ entity: 'task', entityId: '1', descriptor: 'created', correlationId: 'corr-1' });

    await new Promise((r) => setTimeout(r, 20));

    expect(messages).toHaveLength(0);
  });
});
