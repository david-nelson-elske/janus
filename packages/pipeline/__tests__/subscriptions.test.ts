/**
 * Integration tests for M7: Subscriptions.
 *
 * Exercises: subscribe() → compile → broker → subscription processor → dispatch-adapter.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  define,
  participate,
  subscribe,
  compile,
  clearRegistry,
  handler,
  Created,
  Updated,
  Deleted,
  Acted,
} from '@janus/core';
import type { CompileResult } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import type { EntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  startSubscriptionProcessor,
  frameworkEntities,
  frameworkParticipations,
} from '..';
import type { DispatchRuntime, Broker } from '..';
import { Str, Markdown, Lifecycle, Persistent } from '@janus/vocabulary';

// ── Helpers ────────────────────────────────────────────────────────

function wait(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bootstrap a subscription processor from a compiled registry. */
async function bootstrapProcessor(registry: CompileResult) {
  const memAdapter = createMemoryAdapter();
  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memAdapter, memory: memAdapter },
  });
  await store.initialize();

  const broker = createBroker();
  const runtime = createDispatchRuntime({ registry, store, broker });
  const proc = startSubscriptionProcessor({ runtime, broker, store, registry });

  return { store, broker, runtime, proc };
}

// ── subscribe() unit tests ─────────────────────────────────────────

describe('subscribe()', () => {
  test('produces event subscription records', () => {
    const result = subscribe('note', [
      { on: Created, handler: 'dispatch-adapter', config: { entity: 'feed', action: 'notify' } },
    ]);

    expect(result.kind).toBe('subscribe');
    expect(result.records).toHaveLength(1);

    const rec = result.records[0];
    expect(rec.source).toBe('note');
    expect(rec.trigger).toEqual({ kind: 'event', on: Created });
    expect(rec.handler).toBe('dispatch-adapter');
    expect(rec.config).toEqual({ entity: 'feed', action: 'notify' });
    expect(rec.failure).toBe('log'); // default for event
  });

  test('produces cron subscription records', () => {
    const result = subscribe('note', [
      { cron: '0 0 * * *', handler: 'dispatch-adapter', config: { entity: 'note', action: 'purge' } },
    ]);

    expect(result.records).toHaveLength(1);
    const rec = result.records[0];
    expect(rec.trigger).toEqual({ kind: 'cron', expr: '0 0 * * *' });
    expect(rec.failure).toBe('retry'); // default for cron
  });

  test('accepts DefineResult as entity', () => {
    clearRegistry();
    registerHandlers();
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const result = subscribe(note, [
      { on: Updated, handler: 'dispatch-adapter', config: { entity: 'note', action: 'index' } },
    ]);
    expect(result.records[0].source).toBe('note');
    clearRegistry();
  });

  test('respects explicit failure policy', () => {
    const result = subscribe('note', [
      { on: Created, handler: 'dispatch-adapter', config: {}, failure: 'retry' },
    ]);
    expect(result.records[0].failure).toBe('retry');
  });

  test('sets tracked flag', () => {
    const result = subscribe('note', [
      { on: Created, handler: 'dispatch-adapter', config: {}, tracked: true },
    ]);
    expect(result.records[0].tracked).toBe(true);
  });

  test('multiple subscriptions for same entity', () => {
    const result = subscribe('note', [
      { on: Created, handler: 'dispatch-adapter', config: { entity: 'feed', action: 'notify' } },
      { on: Updated, handler: 'dispatch-adapter', config: { entity: 'search', action: 'reindex' } },
      { cron: '0 0 * * *', handler: 'dispatch-adapter', config: { entity: 'note', action: 'cleanup' } },
    ]);
    expect(result.records).toHaveLength(3);
  });
});

// ── subscribe() descriptor variants ──────────────────────────────

describe('subscribe() descriptor variants', () => {
  test('Deleted event descriptor', () => {
    const result = subscribe('note', [
      { on: Deleted, handler: 'dispatch-adapter', config: { entity: 'archive', operation: 'create' } },
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].trigger).toEqual({ kind: 'event', on: Deleted });
  });

  test('Acted() custom action descriptor', () => {
    const result = subscribe('note', [
      { on: Acted('publish'), handler: 'dispatch-adapter', config: { entity: 'feed' } },
    ]);

    expect(result.records).toHaveLength(1);
    const trigger = result.records[0].trigger as { kind: string; on: { kind: string; action: string } };
    expect(trigger.kind).toBe('event');
    expect(trigger.on.kind).toBe('acted');
    expect(trigger.on.action).toBe('publish');
  });

  test('mixed event descriptors in same subscribe() call', () => {
    const result = subscribe('note', [
      { on: Created, handler: 'dispatch-adapter', config: {} },
      { on: Updated, handler: 'dispatch-adapter', config: {} },
      { on: Deleted, handler: 'dispatch-adapter', config: {} },
      { cron: '0 0 * * *', handler: 'dispatch-adapter', config: {} },
    ]);

    expect(result.records).toHaveLength(4);
    expect(result.records[0].trigger).toEqual({ kind: 'event', on: Created });
    expect(result.records[1].trigger).toEqual({ kind: 'event', on: Updated });
    expect(result.records[2].trigger).toEqual({ kind: 'event', on: Deleted });
    expect(result.records[3].trigger.kind).toBe('cron');
  });
});

// ── Subscription processor integration tests ───────────────────────

describe('subscription processor', () => {
  let registry: CompileResult;
  let store: EntityStore;
  let runtime: DispatchRuntime;
  let broker: Broker;
  let processor: { unsubscribe: () => void; drain: () => Promise<void> };

  beforeEach(async () => {
    clearRegistry();
    registerHandlers();

    const note = define('note', {
      schema: {
        title: Str({ required: true }),
        body: Markdown(),
        status: Lifecycle({ draft: ['published'], published: ['archived'] }),
      },
      storage: Persistent(),
    });

    const activity_log = define('activity_log', {
      schema: {
        source_entity: Str(),
        event_type: Str(),
        message: Str(),
      },
      storage: Persistent(),
    });

    const noteP = participate(note, {});
    const logP = participate(activity_log, {});

    const noteSub = subscribe(note, [
      {
        on: Created,
        handler: 'dispatch-adapter',
        config: { entity: 'activity_log', operation: 'create' },
        failure: 'log',
      },
    ]);

    registry = compile([
      note, activity_log,
      noteP, logP,
      noteSub,
      ...frameworkEntities,
      ...frameworkParticipations,
    ]);

    const result = await bootstrapProcessor(registry);
    store = result.store;
    broker = result.broker;
    runtime = result.runtime;
    processor = result.proc;
  });

  afterEach(() => {
    processor.unsubscribe();
    clearRegistry();
  });

  test('event subscription fires on matching broker notification', async () => {
    await runtime.dispatch('system', 'note', 'create', { title: 'Test note' });
    await processor.drain();

    const res = await runtime.dispatch('system', 'activity_log', 'read', {});
    expect(res.ok).toBe(true);
    const page = res.data as { records: unknown[]; total: number };
    expect(page.total).toBeGreaterThanOrEqual(1);
  });

  test('subscription does NOT fire for non-matching entity', async () => {
    broker.notify({
      entity: 'other_entity',
      descriptor: 'created',
      correlationId: 'test-123',
    });

    await processor.drain();

    const res = await runtime.dispatch('system', 'activity_log', 'read', {});
    const page = res.data as { records: unknown[]; total: number };
    expect(page.total).toBe(0);
  });

  test('subscription does NOT fire for non-matching event type', async () => {
    broker.notify({
      entity: 'note',
      descriptor: 'updated',
      correlationId: 'test-456',
    });

    await processor.drain();

    const res = await runtime.dispatch('system', 'activity_log', 'read', {});
    const page = res.data as { records: unknown[]; total: number };
    expect(page.total).toBe(0);
  });

  test('unsubscribe stops all listeners', async () => {
    processor.unsubscribe();

    await runtime.dispatch('system', 'note', 'create', { title: 'After unsubscribe' });
    await processor.drain();

    const res = await runtime.dispatch('system', 'activity_log', 'read', {});
    const page = res.data as { records: unknown[]; total: number };
    expect(page.total).toBe(0);
  });

  test('multiple subscriptions for same entity+event all fire', async () => {
    processor.unsubscribe();
    clearRegistry();
    registerHandlers();

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });

    const log_a = define('log_a', {
      schema: { message: Str() },
      storage: Persistent(),
    });

    const log_b = define('log_b', {
      schema: { message: Str() },
      storage: Persistent(),
    });

    const noteP = participate(note, {});
    const logAP = participate(log_a, {});
    const logBP = participate(log_b, {});

    const subs = subscribe(note, [
      { on: Created, handler: 'dispatch-adapter', config: { entity: 'log_a', operation: 'create' }, failure: 'log' },
      { on: Created, handler: 'dispatch-adapter', config: { entity: 'log_b', operation: 'create' }, failure: 'log' },
    ]);

    const reg = compile([
      note, log_a, log_b,
      noteP, logAP, logBP,
      subs,
      ...frameworkEntities,
      ...frameworkParticipations,
    ]);

    const { runtime: rt, proc } = await bootstrapProcessor(reg);

    await rt.dispatch('system', 'note', 'create', { title: 'Multi-sub test' });
    await proc.drain();

    const resA = await rt.dispatch('system', 'log_a', 'read', {});
    const resB = await rt.dispatch('system', 'log_b', 'read', {});
    const pageA = resA.data as { records: unknown[]; total: number };
    const pageB = resB.data as { records: unknown[]; total: number };

    expect(pageA.total).toBeGreaterThanOrEqual(1);
    expect(pageB.total).toBeGreaterThanOrEqual(1);

    proc.unsubscribe();
  });
});

// ── compile() collects subscriptions ─────────────────────────────

describe('compile with subscriptions', () => {
  beforeEach(() => {
    clearRegistry();
    registerHandlers();
  });

  afterEach(() => {
    clearRegistry();
  });

  test('subscriptions appear on CompileResult', () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const noteSub = subscribe(note, [
      { on: Created, handler: 'dispatch-adapter', config: { entity: 'feed' } },
    ]);

    const result = compile([note, noteP, noteSub]);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0].source).toBe('note');
    expect(result.subscriptions[0].trigger.kind).toBe('event');
  });
});

// ── Failure policy tests ───────────────────────────────────────────

describe('failure policies', () => {
  beforeEach(async () => {
    clearRegistry();
    registerHandlers();
  });

  afterEach(() => {
    clearRegistry();
  });

  test('log policy captures errors without retrying', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const noteSub = subscribe(note, [
      {
        on: Created,
        handler: 'dispatch-adapter',
        config: { entity: 'nonexistent', operation: 'create' },
        failure: 'log',
      },
    ]);

    const registry = compile([
      note, noteP, noteSub,
      ...frameworkEntities,
      ...frameworkParticipations,
    ]);

    const { runtime, proc } = await bootstrapProcessor(registry);

    // This should not throw — error is logged
    await runtime.dispatch('system', 'note', 'create', { title: 'Error test' });
    await proc.drain();

    proc.unsubscribe();
  });
});

// ── Subscription processor edge cases ────────────────────────────

describe('subscription processor — edge cases', () => {
  beforeEach(() => {
    clearRegistry();
    registerHandlers();
  });

  afterEach(() => {
    clearRegistry();
  });

  test('unresolved handler is silently skipped (no crash)', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const noteSub = subscribe(note, [
      { on: Created, handler: 'nonexistent-handler', config: {}, failure: 'log' },
    ]);

    const registry = compile([note, noteP, noteSub, ...frameworkEntities, ...frameworkParticipations]);
    const { runtime, proc } = await bootstrapProcessor(registry);

    await runtime.dispatch('system', 'note', 'create', { title: 'Unresolved handler test' });
    await proc.drain();

    proc.unsubscribe();
  });

  test('subscription fires on delete event', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const delete_log = define('delete_log', {
      schema: { message: Str() },
      storage: Persistent(),
    });

    const noteP = participate(note, {});
    const logP = participate(delete_log, {});

    const noteSub = subscribe(note, [
      {
        on: Deleted,
        handler: 'dispatch-adapter',
        config: { entity: 'delete_log', operation: 'create' },
        failure: 'log',
      },
    ]);

    const registry = compile([
      note, delete_log, noteP, logP, noteSub,
      ...frameworkEntities, ...frameworkParticipations,
    ]);
    const { runtime, proc } = await bootstrapProcessor(registry);

    const created = await runtime.dispatch('system', 'note', 'create', { title: 'To be deleted' });
    const id = (created.data as Record<string, unknown>).id;
    await runtime.dispatch('system', 'note', 'delete', { id });
    await proc.drain();

    const res = await runtime.dispatch('system', 'delete_log', 'read', {});
    const page = res.data as { records: unknown[]; total: number };
    expect(page.total).toBeGreaterThanOrEqual(1);

    proc.unsubscribe();
  });

  test('processor with no event subscriptions returns noop handle', () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});

    const noteSub = subscribe(note, [
      { cron: '0 0 * * *', handler: 'dispatch-adapter', config: {} },
    ]);

    const registry = compile([note, noteP, noteSub, ...frameworkEntities, ...frameworkParticipations]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });
    const proc = startSubscriptionProcessor({ runtime, broker, store, registry });

    expect(typeof proc.unsubscribe).toBe('function');
    expect(typeof proc.drain).toBe('function');
    proc.unsubscribe();
  });

  test('subscription with explicit input dispatches that input', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const event_record = define('event_record', {
      schema: { message: Str() },
      storage: Persistent(),
    });

    const noteP = participate(note, {});
    const eventP = participate(event_record, {});

    const noteSub = subscribe(note, [
      {
        on: Created,
        handler: 'dispatch-adapter',
        config: {
          entity: 'event_record',
          operation: 'create',
          input: { message: 'note was created' },
        },
        failure: 'log',
      },
    ]);

    const registry = compile([
      note, event_record, noteP, eventP, noteSub,
      ...frameworkEntities, ...frameworkParticipations,
    ]);
    const { runtime, proc } = await bootstrapProcessor(registry);

    await runtime.dispatch('system', 'note', 'create', { title: 'Explicit input test' });
    await proc.drain();

    const res = await runtime.dispatch('system', 'event_record', 'read', {});
    const page = res.data as { records: Record<string, unknown>[]; total: number };
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.records[0].message).toBe('note was created');

    proc.unsubscribe();
  });
});
