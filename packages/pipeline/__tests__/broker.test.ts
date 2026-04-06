/**
 * Unit tests for the broker — in-process notification layer.
 *
 * Exercises: global listeners, entity listeners, record listeners,
 * multi-listener dispatch, unsubscribe cleanup.
 */

import { describe, expect, test } from 'bun:test';
import { createBroker } from '..';
import type { BrokerNotification } from '..';

function notification(entity: string, descriptor: string, entityId?: string): BrokerNotification {
  return { entity, descriptor, correlationId: 'test-corr', entityId };
}

describe('createBroker()', () => {
  test('global listener receives all notifications', () => {
    const broker = createBroker();
    const received: BrokerNotification[] = [];
    broker.onNotify((n) => received.push(n));

    broker.notify(notification('note', 'created'));
    broker.notify(notification('task', 'updated', 'task-1'));

    expect(received).toHaveLength(2);
    expect(received[0].entity).toBe('note');
    expect(received[1].entity).toBe('task');
  });

  test('entity listener receives only matching entity notifications', () => {
    const broker = createBroker();
    const received: BrokerNotification[] = [];
    broker.onNotify({ entity: 'note' }, (n) => received.push(n));

    broker.notify(notification('note', 'created'));
    broker.notify(notification('task', 'created'));
    broker.notify(notification('note', 'updated'));

    expect(received).toHaveLength(2);
    expect(received[0].descriptor).toBe('created');
    expect(received[1].descriptor).toBe('updated');
  });

  test('record listener receives only matching entity:id notifications', () => {
    const broker = createBroker();
    const received: BrokerNotification[] = [];
    broker.onNotify({ entity: 'note', entityId: 'note-1' }, (n) => received.push(n));

    broker.notify(notification('note', 'created', 'note-1'));
    broker.notify(notification('note', 'created', 'note-2'));
    broker.notify(notification('note', 'updated', 'note-1'));

    expect(received).toHaveLength(2);
    expect(received[0].descriptor).toBe('created');
    expect(received[1].descriptor).toBe('updated');
  });

  test('multiple listeners all fire', () => {
    const broker = createBroker();
    let globalCount = 0;
    let entityCount = 0;
    let recordCount = 0;

    broker.onNotify(() => globalCount++);
    broker.onNotify({ entity: 'note' }, () => entityCount++);
    broker.onNotify({ entity: 'note', entityId: 'n1' }, () => recordCount++);

    broker.notify(notification('note', 'created', 'n1'));

    expect(globalCount).toBe(1);
    expect(entityCount).toBe(1);
    expect(recordCount).toBe(1);
  });

  test('unsubscribe removes listener (no more events)', () => {
    const broker = createBroker();
    let count = 0;
    const unsub = broker.onNotify(() => count++);

    broker.notify(notification('note', 'created'));
    expect(count).toBe(1);

    unsub();
    broker.notify(notification('note', 'created'));
    expect(count).toBe(1);
  });

  test('entity listener cleanup: unsubscribe deletes empty Set', () => {
    const broker = createBroker();
    const received: BrokerNotification[] = [];
    const unsub = broker.onNotify({ entity: 'note' }, (n) => received.push(n));

    broker.notify(notification('note', 'created'));
    expect(received).toHaveLength(1);

    unsub();

    // After unsubscribe, the entity listener should not fire
    broker.notify(notification('note', 'updated'));
    expect(received).toHaveLength(1);
  });

  test('record listener cleanup: unsubscribe deletes empty Set', () => {
    const broker = createBroker();
    const received: BrokerNotification[] = [];
    const unsub = broker.onNotify({ entity: 'note', entityId: 'n1' }, (n) => received.push(n));

    broker.notify(notification('note', 'created', 'n1'));
    expect(received).toHaveLength(1);

    unsub();

    // After unsubscribe, the record listener should not fire
    broker.notify(notification('note', 'updated', 'n1'));
    expect(received).toHaveLength(1);
  });

  test('notification without entityId does not fire record listeners', () => {
    const broker = createBroker();
    let recordCount = 0;
    let entityCount = 0;

    broker.onNotify({ entity: 'note', entityId: 'n1' }, () => recordCount++);
    broker.onNotify({ entity: 'note' }, () => entityCount++);

    // No entityId — entity listener fires, record listener does not
    broker.notify(notification('note', 'created'));

    expect(entityCount).toBe(1);
    expect(recordCount).toBe(0);
  });

  test('notification with entityId fires both entity and record listeners', () => {
    const broker = createBroker();
    let entityCount = 0;
    let recordCount = 0;

    broker.onNotify({ entity: 'note' }, () => entityCount++);
    broker.onNotify({ entity: 'note', entityId: 'n1' }, () => recordCount++);

    broker.notify(notification('note', 'created', 'n1'));

    expect(entityCount).toBe(1);
    expect(recordCount).toBe(1);
  });
});
