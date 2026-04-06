/**
 * M4 tests: audit, policy, invariant, identity metadata.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, clearRegistry, ANONYMOUS } from '@janus/core';
import { AuditFull, Str, Int, Persistent } from '@janus/vocabulary';
import { registerHandlers, createDispatchRuntime, frameworkEntities, frameworkParticipations } from '..';
import { createMemoryAdapter, createEntityStore } from '@janus/store';

afterEach(() => clearRegistry());

function setup(config: { audit?: any; policy?: any; invariant?: any } = {}) {
  clearRegistry();
  registerHandlers();

  const note = define('note', {
    schema: { title: Str({ required: true }), count: Int() },
    storage: Persistent(),
  });
  const noteP = participate(note, config);
  const reg = compile([note, noteP, ...frameworkEntities, ...frameworkParticipations]);
  const adapter = createMemoryAdapter();
  const store = createEntityStore({ routing: reg.persistRouting, adapters: { relational: adapter, memory: adapter } });
  return { reg, store };
}

// ── Audit ───────────────────────────────────────────────────────

describe('audit-relational', () => {
  test('writes audit entry to execution_log on create', async () => {
    const { reg, store } = setup({ audit: AuditFull });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    await runtime.dispatch('system', 'note', 'create', { title: 'Test' });

    const logRes = await runtime.dispatch('system', 'execution_log', 'read', {});
    const page = logRes.data as { records: Record<string, unknown>[] };
    const auditEntries = page.records.filter(r => r.handler === 'audit-relational');
    expect(auditEntries.length).toBeGreaterThan(0);
    expect(auditEntries[0].source).toBe('note');
  });

  test('audit payload contains actor and after snapshot', async () => {
    const { reg, store } = setup({ audit: AuditFull });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    await runtime.dispatch('system', 'note', 'create', { title: 'Test' }, { id: 'alice', roles: ['admin'] });

    const logRes = await runtime.dispatch('system', 'execution_log', 'read', {});
    const page = logRes.data as { records: Record<string, unknown>[] };
    const entry = page.records.find(r => r.handler === 'audit-relational');
    const payload = entry?.payload as Record<string, unknown>;
    expect((payload.actor as Record<string, unknown>).id).toBe('alice');
    expect(payload.after).toBeDefined();
  });

  test('no audit entries without audit config', async () => {
    const { reg, store } = setup();
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    await runtime.dispatch('system', 'note', 'create', { title: 'Test' });

    const logRes = await runtime.dispatch('system', 'execution_log', 'read', {});
    const page = logRes.data as { records: Record<string, unknown>[] };
    const auditEntries = page.records.filter(r => r.handler === 'audit-relational');
    expect(auditEntries).toHaveLength(0);
  });
});

// ── Policy ──────────────────────────────────────────────────────

describe('policy-lookup', () => {
  test('allows matching role + operation', async () => {
    const { reg, store } = setup({
      policy: { rules: [{ role: 'admin', operations: '*' }] },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'create',
      { title: 'Test' },
      { id: 'alice', roles: ['admin'] },
    );
    expect(res.ok).toBe(true);
  });

  test('denies non-matching role', async () => {
    const { reg, store } = setup({
      policy: { rules: [{ role: 'admin', operations: '*' }] },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'create',
      { title: 'Test' },
      { id: 'bob', roles: ['user'] },
    );
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('auth-error');
  });

  test('allows anonymous read with anonymousRead: true', async () => {
    const { reg, store } = setup({
      policy: { rules: [{ role: 'admin', operations: '*' }], anonymousRead: true },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'read', {}, ANONYMOUS);
    expect(res.ok).toBe(true);
  });

  test('denies anonymous write even with anonymousRead', async () => {
    const { reg, store } = setup({
      policy: { rules: [{ role: 'admin', operations: '*' }], anonymousRead: true },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'create', { title: 'Test' }, ANONYMOUS);
    expect(res.ok).toBe(false);
  });

  test('operation-specific rules', async () => {
    const { reg, store } = setup({
      policy: { rules: [{ role: 'user', operations: ['read', 'create'] }] },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const createRes = await runtime.dispatch('system', 'note', 'create',
      { title: 'Test' }, { id: 'alice', roles: ['user'] },
    );
    expect(createRes.ok).toBe(true);

    const createdId = (createRes.data as Record<string, unknown>).id;
    const deleteRes = await runtime.dispatch('system', 'note', 'delete',
      { id: createdId }, { id: 'alice', roles: ['user'] },
    );
    expect(deleteRes.ok).toBe(false);
    expect(deleteRes.error?.kind).toBe('auth-error');
  });
});

// ── Invariant ───────────────────────────────────────────────────

describe('invariant-check', () => {
  test('error severity rejects dispatch', async () => {
    const { reg, store } = setup({
      invariant: [
        { name: 'title-not-empty', predicate: (r: Record<string, unknown>) => (r.title as string)?.length > 0, severity: 'error' },
      ],
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'create', { title: '' });
    expect(res.ok).toBe(false);
    expect(res.error?.kind).toBe('invariant-violation');
  });

  test('passing invariant allows dispatch', async () => {
    const { reg, store } = setup({
      invariant: [
        { name: 'title-not-empty', predicate: (r: Record<string, unknown>) => (r.title as string)?.length > 0, severity: 'error' },
      ],
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    const res = await runtime.dispatch('system', 'note', 'create', { title: 'Valid' });
    expect(res.ok).toBe(true);
  });

  test('warning severity captures but does not reject', async () => {
    const { reg, store } = setup({
      invariant: [
        { name: 'count-positive', predicate: (r: Record<string, unknown>) => (r.count as number ?? 0) > 0, severity: 'warning' as const },
      ],
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: reg, store });

    // count is not set (undefined/0), warning should fire but dispatch succeeds
    const res = await runtime.dispatch('system', 'note', 'create', { title: 'Test' });
    expect(res.ok).toBe(true);
  });
});

// ── Broker ──────────────────────────────────────────────────────

describe('broker', () => {
  test('emit-broker notifies broker on write operations', async () => {
    clearRegistry();
    registerHandlers();

    const { createBroker } = await import('..');

    const note = define('note', { schema: { title: Str({ required: true }) }, storage: Persistent() });
    const noteP = participate(note, {});
    const reg = compile([note, noteP, ...frameworkEntities, ...frameworkParticipations]);
    const adapter = createMemoryAdapter();
    const store = createEntityStore({ routing: reg.persistRouting, adapters: { relational: adapter, memory: adapter } });
    await store.initialize();

    const broker = createBroker();
    const notifications: any[] = [];
    broker.onNotify((n) => notifications.push(n));

    const runtime = createDispatchRuntime({ registry: reg, store, broker });

    const res = await runtime.dispatch('system', 'note', 'create', { title: 'Test' });
    expect(res.ok).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].entity).toBe('note');
    expect(notifications[0].descriptor).toBe('created');
  });
});
