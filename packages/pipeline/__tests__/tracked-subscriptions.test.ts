/**
 * Tests for M7 completion: tracked subscriptions, dead-letter, RetryConfig, scheduler.
 *
 * ADR 07b: tracked subscriptions write status rows to execution_log.
 * ADR 07: scheduler fires cron-triggered subscriptions.
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
} from '@janus/core';
import type { CompileResult, EntityRecord, ReadPage } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import type { EntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  startSubscriptionProcessor,
  startScheduler,
  calculateBackoff,
  frameworkEntities,
  frameworkParticipations,
} from '..';
import type { DispatchRuntime, Broker } from '..';
import { Str, Persistent } from '@janus/vocabulary';

// ── Test helpers ─────────────────────────────────────────────────

function wait(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read execution_log records, optionally filtered by status. */
async function readLogRecords(
  runtime: DispatchRuntime,
  where?: Record<string, unknown>,
): Promise<EntityRecord[]> {
  const res = await runtime.dispatch('system', 'execution_log', 'read', where ? { where } : {});
  const page = res.data as ReadPage;
  return page.records as EntityRecord[];
}

// ── calculateBackoff unit tests ──────────────────────────────────

describe('calculateBackoff()', () => {
  test('uses RetryConfig exponential backoff', () => {
    const retry = { max: 3, backoff: 'exponential' as const, initialDelay: 1000 };
    expect(calculateBackoff(retry, 1)).toBe(1000);
    expect(calculateBackoff(retry, 2)).toBe(2000);
    expect(calculateBackoff(retry, 3)).toBe(4000);
  });

  test('uses RetryConfig fixed backoff', () => {
    const retry = { max: 3, backoff: 'fixed' as const, initialDelay: 500 };
    expect(calculateBackoff(retry, 1)).toBe(500);
    expect(calculateBackoff(retry, 2)).toBe(500);
    expect(calculateBackoff(retry, 3)).toBe(500);
  });

  test('falls back to hardcoded backoff without RetryConfig', () => {
    expect(calculateBackoff(undefined, 1)).toBe(100);
    expect(calculateBackoff(undefined, 2)).toBe(500);
    expect(calculateBackoff(undefined, 3)).toBe(2500);
  });
});

// ── Tracked subscription tests ───────────────────────────────────

describe('tracked subscriptions', () => {
  let registry: CompileResult;
  let store: EntityStore;
  let runtime: DispatchRuntime;
  let broker: Broker;
  let processor: { unsubscribe: () => void; drain: () => Promise<void> };

  beforeEach(async () => {
    clearRegistry();
    registerHandlers();
  });

  afterEach(() => {
    processor?.unsubscribe();
    clearRegistry();
  });

  async function setupWith(subs: Parameters<typeof subscribe>[1]) {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });

    const log_target = define('log_target', {
      schema: { message: Str() },
      storage: Persistent(),
    });

    const noteP = participate(note, {});
    const logP = participate(log_target, {});

    const noteSub = subscribe(note, subs);

    registry = compile([
      note, log_target,
      noteP, logP,
      noteSub,
      ...frameworkEntities,
      ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });

    await store.initialize();
    broker = createBroker();
    runtime = createDispatchRuntime({ registry, store, broker });
    processor = startSubscriptionProcessor({ runtime, broker, store, registry });
  }

  // ── Core tracking behavior ──────────────────────────────────

  test('tracked subscription writes running + completed to execution_log', async () => {
    await setupWith([{
      on: Created,
      handler: 'dispatch-adapter',
      config: { entity: 'log_target', operation: 'create' },
      tracked: true,
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Track me' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.handler === 'dispatch-adapter' && r.source === 'note');

    const statuses = subLogs.map(r => r.status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('completed');
  });

  test('untracked subscription writes NO execution_log rows', async () => {
    await setupWith([{
      on: Created,
      handler: 'dispatch-adapter',
      config: { entity: 'log_target', operation: 'create' },
      // tracked is NOT set
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'No tracking' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.source === 'note' && r.handler === 'dispatch-adapter');
    expect(subLogs).toHaveLength(0);
  });

  test('successful handler writes exactly running + completed (2 log rows)', async () => {
    await setupWith([{
      on: Created,
      handler: 'dispatch-adapter',
      config: { entity: 'log_target', operation: 'create' },
      tracked: true,
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Count logs' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.handler === 'dispatch-adapter' && r.source === 'note');
    expect(subLogs.filter(r => r.status === 'running')).toHaveLength(1);
    expect(subLogs.filter(r => r.status === 'completed')).toHaveLength(1);
    expect(subLogs).toHaveLength(2);
  });

  // ── Failure and retry behavior ──────────────────────────────

  test('tracked failure writes failed status, exhaustion writes dead with forever retention', async () => {
    handler('always-fail', async () => { throw new Error('boom'); }, 'A handler that always fails');

    await setupWith([{
      on: Created,
      handler: 'always-fail',
      config: {},
      failure: 'retry',
      tracked: true,
      // No RetryConfig → falls back to hardcoded 3 attempts
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Fail me' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.handler === 'always-fail' && r.source === 'note');

    // Should have: running(1), failed(1), running(2), failed(2), running(3), dead(3)
    const statuses = subLogs.map(r => r.status);
    expect(statuses.filter(s => s === 'running')).toHaveLength(3);
    expect(statuses.filter(s => s === 'failed')).toHaveLength(2);
    expect(statuses.filter(s => s === 'dead')).toHaveLength(1);

    const deadRow = subLogs.find(r => r.status === 'dead');
    expect(deadRow!.retention).toBe('forever');
  });

  test('RetryConfig controls max attempts and uses configured backoff', async () => {
    handler('fail-twice', (() => {
      let calls = 0;
      return async () => {
        calls++;
        if (calls <= 2) throw new Error(`fail #${calls}`);
        // succeeds on 3rd call
      };
    })(), 'Fails twice then succeeds');

    await setupWith([{
      on: Created,
      handler: 'fail-twice',
      config: {},
      failure: 'retry',
      tracked: true,
      retry: { max: 5, backoff: 'fixed', initialDelay: 10 },
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Retry test' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.handler === 'fail-twice' && r.source === 'note');

    // Should have: running(1), failed(1), running(2), failed(2), running(3), completed(3)
    const statuses = subLogs.map(r => r.status);
    expect(statuses.filter(s => s === 'running')).toHaveLength(3);
    expect(statuses.filter(s => s === 'failed')).toHaveLength(2);
    expect(statuses.filter(s => s === 'completed')).toHaveLength(1);
    expect(statuses.filter(s => s === 'dead')).toHaveLength(0);
  });

  test('log policy with tracked subscription writes running then dead on first failure', async () => {
    handler('tracked-fail-log', async () => { throw new Error('log-fail'); }, 'Fails with log policy');

    await setupWith([{
      on: Created,
      handler: 'tracked-fail-log',
      config: {},
      failure: 'log',
      tracked: true,
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Log policy fail' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.handler === 'tracked-fail-log' && r.source === 'note');

    const statuses = subLogs.map(r => r.status);
    expect(statuses).toContain('running');
    expect(statuses).toContain('dead');
    // Only 1 attempt → no 'failed', straight to 'dead'
    expect(statuses.filter(s => s === 'failed')).toHaveLength(0);
    expect(subLogs.find(r => r.status === 'dead')!.retention).toBe('forever');
  });

  test('retry with max=1 acts like log policy (no actual retries)', async () => {
    handler('fail-max1', async () => { throw new Error('once'); }, 'Fails once');

    await setupWith([{
      on: Created,
      handler: 'fail-max1',
      config: {},
      failure: 'retry',
      tracked: true,
      retry: { max: 1, backoff: 'fixed', initialDelay: 10 },
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Max 1 retry' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.handler === 'fail-max1' && r.source === 'note');

    expect(subLogs.filter(r => r.status === 'running')).toHaveLength(1);
    expect(subLogs.filter(r => r.status === 'dead')).toHaveLength(1);
    expect(subLogs.filter(r => r.status === 'failed')).toHaveLength(0);
  });

  // ── Dead-letter and payload ─────────────────────────────────

  test('dead-lettered work is queryable by status', async () => {
    handler('always-fail-2', async () => { throw new Error('nope'); }, 'Always fails');

    await setupWith([{
      on: Created,
      handler: 'always-fail-2',
      config: {},
      failure: 'retry',
      tracked: true,
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Dead letter' });
    await processor.drain();

    const deadLogs = await readLogRecords(runtime, { status: 'dead' });
    expect(deadLogs.length).toBeGreaterThanOrEqual(1);
    expect(deadLogs[0].handler).toBe('always-fail-2');
    expect(deadLogs[0].retention).toBe('forever');

    const payload = deadLogs[0].payload as Record<string, unknown>;
    expect(payload.error).toBe('nope');
  });

  test('non-Error thrown object is captured in dead-letter payload', async () => {
    handler('throw-string', async () => { throw 'string error message'; }, 'Throws a string');

    await setupWith([{
      on: Created,
      handler: 'throw-string',
      config: {},
      failure: 'log',
      tracked: true,
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'String throw test' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const deadLog = logs.find(r => r.handler === 'throw-string' && r.status === 'dead');
    expect(deadLog).toBeDefined();
    const payload = deadLog!.payload as Record<string, unknown>;
    expect(payload.error).toBe('string error message');
  });

  test('each execution_log row carries its own retention value', async () => {
    handler('always-fail-3', async () => { throw new Error('oops'); }, 'Always fails');

    await setupWith([{
      on: Created,
      handler: 'always-fail-3',
      config: {},
      failure: 'retry',
      tracked: true,
    }]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Retention check' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const subLogs = logs.filter(r => r.handler === 'always-fail-3');

    for (const log of subLogs) {
      expect(log.retention).toBeDefined();
      if (log.status === 'dead') {
        expect(log.retention).toBe('forever');
      } else {
        expect(log.retention).toBe('90d');
      }
    }
  });

  // ── Multiple subscriptions ──────────────────────────────────

  test('multiple tracked subscriptions for same event each write separate logs', async () => {
    handler('track-a', async () => {}, 'Handler A');
    handler('track-b', async () => {}, 'Handler B');

    await setupWith([
      { on: Created, handler: 'track-a', config: {}, tracked: true },
      { on: Created, handler: 'track-b', config: {}, tracked: true },
    ]);

    await runtime.dispatch('system', 'note', 'create', { title: 'Multi tracked' });
    await processor.drain();

    const logs = await readLogRecords(runtime);
    const aLogs = logs.filter(r => r.handler === 'track-a' && r.source === 'note');
    const bLogs = logs.filter(r => r.handler === 'track-b' && r.source === 'note');

    expect(aLogs.filter(r => r.status === 'completed')).toHaveLength(1);
    expect(bLogs.filter(r => r.status === 'completed')).toHaveLength(1);
  });
});

// ── subscribe() with RetryConfig ───────────────────────────────────

describe('subscribe() with RetryConfig', () => {
  beforeEach(() => {
    clearRegistry();
    registerHandlers();
  });

  afterEach(() => {
    clearRegistry();
  });

  test('retry config appears on subscription record', () => {
    const result = subscribe('note', [{
      on: Created,
      handler: 'dispatch-adapter',
      config: {},
      tracked: true,
      retry: { max: 5, backoff: 'exponential', initialDelay: 2000 },
    }]);

    expect(result.records[0].retry).toEqual({
      max: 5,
      backoff: 'exponential',
      initialDelay: 2000,
    });
  });

  test('retry config on cron subscription', () => {
    const result = subscribe('note', [{
      cron: '0 0 * * *',
      handler: 'dispatch-adapter',
      config: {},
      tracked: true,
      retry: { max: 3, backoff: 'fixed', initialDelay: 1000 },
    }]);

    expect(result.records[0].retry).toEqual({
      max: 3,
      backoff: 'fixed',
      initialDelay: 1000,
    });
    expect(result.records[0].trigger.kind).toBe('cron');
  });

  test('retry config is optional (undefined when not provided)', () => {
    const result = subscribe('note', [{
      on: Created,
      handler: 'dispatch-adapter',
      config: {},
    }]);

    expect(result.records[0].retry).toBeUndefined();
  });
});

// ── Scheduler integration tests ──────────────────────────────────

describe('scheduler', () => {
  beforeEach(() => {
    clearRegistry();
    registerHandlers();
  });

  afterEach(() => {
    clearRegistry();
  });

  test('startScheduler returns handle with stop and drain', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const noteSub = subscribe(note, [{
      cron: '0 0 * * *',
      handler: 'dispatch-adapter',
      config: { entity: 'note', operation: 'read' },
    }]);

    const registry = compile([note, noteP, noteSub, ...frameworkEntities, ...frameworkParticipations]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const runtime = createDispatchRuntime({ registry, store });
    const scheduler = startScheduler({ runtime, store, registry });

    expect(typeof scheduler.stop).toBe('function');
    expect(typeof scheduler.drain).toBe('function');

    scheduler.stop();
  });

  test('stop prevents scheduled subscriptions from firing', async () => {
    let callCount = 0;
    handler('call-counter', async () => { callCount++; }, 'Counts calls');

    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const noteSub = subscribe(note, [{
      cron: '* * * * *',
      handler: 'call-counter',
      config: {},
    }]);

    const registry = compile([note, noteP, noteSub, ...frameworkEntities, ...frameworkParticipations]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const runtime = createDispatchRuntime({ registry, store });
    const scheduler = startScheduler({ runtime, store, registry });

    scheduler.stop();
    await wait(100);

    expect(callCount).toBe(0);
  });

  test('scheduler ignores event subscriptions', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const noteSub = subscribe(note, [{
      on: Created,
      handler: 'dispatch-adapter',
      config: { entity: 'note', operation: 'read' },
    }]);

    const registry = compile([note, noteP, noteSub, ...frameworkEntities, ...frameworkParticipations]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const runtime = createDispatchRuntime({ registry, store });
    const scheduler = startScheduler({ runtime, store, registry });

    // Should not throw, should do nothing (no cron subs)
    scheduler.stop();
  });

  test('cron subscriptions appear on CompileResult alongside event subs', () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const noteP = participate(note, {});
    const noteSub = subscribe(note, [
      { on: Created, handler: 'dispatch-adapter', config: { entity: 'note' } },
      { cron: '0 0 * * *', handler: 'dispatch-adapter', config: { entity: 'note', action: 'cleanup' } },
    ]);

    const registry = compile([note, noteP, noteSub]);
    expect(registry.subscriptions).toHaveLength(2);

    const event = registry.subscriptions.find(s => s.trigger.kind === 'event');
    const cron = registry.subscriptions.find(s => s.trigger.kind === 'cron');
    expect(event).toBeDefined();
    expect(cron).toBeDefined();
    expect((cron!.trigger as { expr: string }).expr).toBe('0 0 * * *');
  });
});
