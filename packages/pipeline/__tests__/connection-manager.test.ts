/**
 * Tests for ConnectionManager — in-memory SSE connection tracking.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { createConnectionManager } from '../connection-manager';
import type { ConnectionManager, SseConnection } from '../connection-manager';

let manager: ConnectionManager;

function mockConnection(overrides: Partial<SseConnection> = {}): SseConnection {
  const enqueued: string[] = [];
  return {
    id: overrides.id ?? crypto.randomUUID(),
    userId: overrides.userId ?? 'user1',
    controller: {
      enqueue: (chunk: string) => enqueued.push(chunk),
      close: () => {},
    },
    subscriptions: overrides.subscriptions ?? new Set(['task']),
    connectedAt: overrides.connectedAt ?? Date.now(),
    lastHeartbeat: overrides.lastHeartbeat ?? Date.now(),
  };
}

beforeEach(() => {
  manager = createConnectionManager();
});

describe('ConnectionManager', () => {
  test('add and get a connection', () => {
    const conn = mockConnection({ id: 'conn-1' });
    manager.add(conn);
    expect(manager.get('conn-1')).toBe(conn);
    expect(manager.size).toBe(1);
  });

  test('remove a connection', () => {
    const conn = mockConnection({ id: 'conn-1' });
    manager.add(conn);
    manager.remove('conn-1');
    expect(manager.get('conn-1')).toBeUndefined();
    expect(manager.size).toBe(0);
  });

  test('remove non-existent connection is a no-op', () => {
    manager.remove('nonexistent');
    expect(manager.size).toBe(0);
  });

  test('all() returns all connections', () => {
    manager.add(mockConnection({ id: 'a' }));
    manager.add(mockConnection({ id: 'b' }));
    expect(manager.all()).toHaveLength(2);
  });

  test('findSubscribers matches type-level subscriptions', () => {
    manager.add(mockConnection({ id: 'a', subscriptions: new Set(['task']) }));
    manager.add(mockConnection({ id: 'b', subscriptions: new Set(['adr']) }));
    const subs = manager.findSubscribers('task');
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe('a');
  });

  test('findSubscribers matches instance-level subscriptions', () => {
    manager.add(mockConnection({ id: 'a', subscriptions: new Set(['task:123']) }));
    manager.add(mockConnection({ id: 'b', subscriptions: new Set(['task']) }));
    const subs = manager.findSubscribers('task', '123');
    expect(subs).toHaveLength(2); // both match
  });

  test('findSubscribers returns empty for no matches', () => {
    manager.add(mockConnection({ id: 'a', subscriptions: new Set(['adr']) }));
    expect(manager.findSubscribers('task')).toHaveLength(0);
  });

  test('push sends SSE message to connection', () => {
    const enqueued: string[] = [];
    const conn = mockConnection({ id: 'a' });
    (conn.controller as any).enqueue = (s: string) => enqueued.push(s);
    manager.add(conn);

    const sent = manager.push('a', { type: 'heartbeat', timestamp: 123 });
    expect(sent).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toContain('"type":"heartbeat"');
  });

  test('push returns false for unknown connection', () => {
    expect(manager.push('nonexistent', { type: 'heartbeat' })).toBe(false);
  });

  test('push removes connection on error', () => {
    const conn = mockConnection({ id: 'a' });
    (conn.controller as any).enqueue = () => { throw new Error('closed'); };
    manager.add(conn);

    const sent = manager.push('a', { type: 'heartbeat' });
    expect(sent).toBe(false);
    expect(manager.size).toBe(0);
  });

  test('pushToSubscribers sends to all matching connections', () => {
    const enqueued1: string[] = [];
    const enqueued2: string[] = [];

    const c1 = mockConnection({ id: 'a', subscriptions: new Set(['task']) });
    (c1.controller as any).enqueue = (s: string) => enqueued1.push(s);

    const c2 = mockConnection({ id: 'b', subscriptions: new Set(['task']) });
    (c2.controller as any).enqueue = (s: string) => enqueued2.push(s);

    manager.add(c1);
    manager.add(c2);

    manager.pushToSubscribers('task', '123', { type: 'entity:changed', entity: 'task', id: '123' });
    expect(enqueued1).toHaveLength(1);
    expect(enqueued2).toHaveLength(1);
  });

  test('pushToSubscribers skips specified connection', () => {
    const enqueued1: string[] = [];
    const enqueued2: string[] = [];

    const c1 = mockConnection({ id: 'a', subscriptions: new Set(['task']) });
    (c1.controller as any).enqueue = (s: string) => enqueued1.push(s);

    const c2 = mockConnection({ id: 'b', subscriptions: new Set(['task']) });
    (c2.controller as any).enqueue = (s: string) => enqueued2.push(s);

    manager.add(c1);
    manager.add(c2);

    manager.pushToSubscribers('task', '123', { type: 'entity:changed' }, 'a');
    expect(enqueued1).toHaveLength(0); // skipped
    expect(enqueued2).toHaveLength(1);
  });

  test('pushToSubscribers removes broken connections', () => {
    const c1 = mockConnection({ id: 'a', subscriptions: new Set(['task']) });
    (c1.controller as any).enqueue = () => { throw new Error('closed'); };
    manager.add(c1);

    manager.pushToSubscribers('task', '123', { type: 'entity:changed' });
    expect(manager.size).toBe(0);
  });
});
