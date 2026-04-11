/**
 * Tests for the scope-enforce concern (ADR 01e).
 *
 * Matrix: { sysadmin, lead, contributor, no-assignments } ×
 *         { system, province, mixed } × { read, create, update, delete }.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  define,
  participate,
  compile,
  clearRegistry,
  type Identity,
} from '@janus/core';
import { Str, Persistent } from '@janus/vocabulary';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
} from '..';
import type { DispatchRuntime } from '..';

afterEach(() => clearRegistry());

// ── Bootstrap ───────────────────────────────────────────────────

async function bootstrap() {
  registerHandlers();

  // System-tier entity (no per-row scope field)
  const fact = define('fact', {
    schema: { title: Str({ required: true }) },
    storage: Persistent(),
    scope: { tier: 'system' },
  });
  const factP = participate(fact, { scope: true });

  // Province-tier entity (every row has a region)
  const contact = define('contact', {
    schema: {
      name: Str({ required: true }),
      region: Str({ required: true }),
    },
    storage: Persistent(),
    scope: { tier: 'province', field: 'region' },
  });
  const contactP = participate(contact, { scope: true });

  // Mixed-tier entity (region nullable; null = system-tier)
  const milestone = define('milestone', {
    schema: {
      title: Str({ required: true }),
      region: Str(),
    },
    storage: Persistent(),
    scope: { tier: 'mixed', field: 'region' },
  });
  const milestoneP = participate(milestone, { scope: true });

  const initiator = {
    name: 'test-surface',
    origin: 'consumer' as const,
    participations: [],
  };

  const registry = compile(
    [fact, factP, contact, contactP, milestone, milestoneP, ...frameworkEntities, ...frameworkParticipations],
    [initiator],
  );

  const adapter = createMemoryAdapter();
  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: adapter, memory: adapter },
  });
  await store.initialize();

  const broker = createBroker();
  const runtime = createDispatchRuntime({ registry, store, broker });

  return { runtime, store };
}

// ── Identity helpers ────────────────────────────────────────────

const sysadmin: Identity = Object.freeze({
  id: 'admin-1',
  roles: Object.freeze(['sysadmin']),
});

const albertaLead: Identity = Object.freeze({
  id: 'lead-1',
  roles: Object.freeze(['province_lead']),
  assignments: Object.freeze([{ scope: 'alberta', role: 'lead' }]),
});

const multiRegionLead: Identity = Object.freeze({
  id: 'lead-2',
  roles: Object.freeze(['province_lead']),
  assignments: Object.freeze([
    { scope: 'alberta', role: 'lead' },
    { scope: 'canada', role: 'contributor' },
  ]),
});

const noAssignments: Identity = Object.freeze({
  id: 'orphan-1',
  roles: Object.freeze(['province_lead']),
  assignments: Object.freeze([]),
});

// ── Helpers ─────────────────────────────────────────────────────

function dispatch(runtime: DispatchRuntime, entity: string, op: string, input: unknown, id: Identity) {
  return runtime.dispatch('test-surface', entity, op, input, id);
}

async function seedFact(runtime: DispatchRuntime, title: string) {
  const r = await dispatch(runtime, 'fact', 'create', { title }, sysadmin);
  if (!r.ok) throw new Error(`seed fact failed: ${r.error?.message}`);
  return (r.data as { id: string }).id;
}

async function seedContact(runtime: DispatchRuntime, name: string, region: string) {
  const r = await dispatch(runtime, 'contact', 'create', { name, region }, sysadmin);
  if (!r.ok) throw new Error(`seed contact failed: ${r.error?.message}`);
  return (r.data as { id: string }).id;
}

async function seedMilestone(runtime: DispatchRuntime, title: string, region: string | null) {
  const input = region == null ? { title } : { title, region };
  const r = await dispatch(runtime, 'milestone', 'create', input, sysadmin);
  if (!r.ok) throw new Error(`seed milestone failed: ${r.error?.message}`);
  return (r.data as { id: string }).id;
}

// ── System tier ─────────────────────────────────────────────────

describe('scope-enforce — system tier', () => {
  test('sysadmin can write system-tier rows', async () => {
    const { runtime } = await bootstrap();
    const r = await dispatch(runtime, 'fact', 'create', { title: 'UL 3700 published' }, sysadmin);
    expect(r.ok).toBe(true);
  });

  test('non-sysadmin cannot write system-tier rows', async () => {
    const { runtime } = await bootstrap();
    const r = await dispatch(runtime, 'fact', 'create', { title: 'rogue fact' }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('non-sysadmin can read system-tier rows', async () => {
    const { runtime } = await bootstrap();
    await seedFact(runtime, 'UL 3700');
    const r = await dispatch(runtime, 'fact', 'read', {}, albertaLead);
    expect(r.ok).toBe(true);
    expect((r.data as { records: unknown[] }).records.length).toBe(1);
  });

  test('non-sysadmin cannot delete system-tier rows', async () => {
    const { runtime } = await bootstrap();
    const id = await seedFact(runtime, 'UL 3700');
    const r = await dispatch(runtime, 'fact', 'delete', { id }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });
});

// ── Province tier ───────────────────────────────────────────────

describe('scope-enforce — province tier', () => {
  test('lead reads only their assigned region', async () => {
    const { runtime } = await bootstrap();
    await seedContact(runtime, 'Alice', 'alberta');
    await seedContact(runtime, 'Bob', 'bc');
    await seedContact(runtime, 'Carol', 'alberta');

    const r = await dispatch(runtime, 'contact', 'read', {}, albertaLead);
    expect(r.ok).toBe(true);
    const names = (r.data as { records: { name: string }[] }).records.map((x) => x.name).sort();
    expect(names).toEqual(['Alice', 'Carol']);
  });

  test('multi-region lead reads from all assigned regions', async () => {
    const { runtime } = await bootstrap();
    await seedContact(runtime, 'Alice', 'alberta');
    await seedContact(runtime, 'Bob', 'bc');
    await seedContact(runtime, 'Carol', 'canada');

    const r = await dispatch(runtime, 'contact', 'read', {}, multiRegionLead);
    expect(r.ok).toBe(true);
    const names = (r.data as { records: { name: string }[] }).records.map((x) => x.name).sort();
    expect(names).toEqual(['Alice', 'Carol']);
  });

  test('user with no assignments sees nothing', async () => {
    const { runtime } = await bootstrap();
    await seedContact(runtime, 'Alice', 'alberta');
    const r = await dispatch(runtime, 'contact', 'read', {}, noAssignments);
    expect(r.ok).toBe(true);
    expect((r.data as { records: unknown[] }).records.length).toBe(0);
  });

  test('sysadmin reads all regions', async () => {
    const { runtime } = await bootstrap();
    await seedContact(runtime, 'Alice', 'alberta');
    await seedContact(runtime, 'Bob', 'bc');
    const r = await dispatch(runtime, 'contact', 'read', {}, sysadmin);
    expect(r.ok).toBe(true);
    expect((r.data as { records: unknown[] }).records.length).toBe(2);
  });

  test('lead can create in their own region', async () => {
    const { runtime } = await bootstrap();
    const r = await dispatch(runtime, 'contact', 'create', { name: 'New Person', region: 'alberta' }, albertaLead);
    expect(r.ok).toBe(true);
  });

  test('lead cannot create in another region', async () => {
    const { runtime } = await bootstrap();
    const r = await dispatch(runtime, 'contact', 'create', { name: 'New Person', region: 'bc' }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('lead can update a row in their region', async () => {
    const { runtime } = await bootstrap();
    const id = await seedContact(runtime, 'Alice', 'alberta');
    const r = await dispatch(runtime, 'contact', 'update', { id, name: 'Alice Updated' }, albertaLead);
    expect(r.ok).toBe(true);
  });

  test('lead cannot update a row in another region', async () => {
    const { runtime } = await bootstrap();
    const id = await seedContact(runtime, 'Bob', 'bc');
    const r = await dispatch(runtime, 'contact', 'update', { id, name: 'Hijacked' }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('lead cannot delete a row in another region', async () => {
    const { runtime } = await bootstrap();
    const id = await seedContact(runtime, 'Bob', 'bc');
    const r = await dispatch(runtime, 'contact', 'delete', { id }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('lead cannot move a row out of their region', async () => {
    const { runtime } = await bootstrap();
    const id = await seedContact(runtime, 'Alice', 'alberta');
    const r = await dispatch(runtime, 'contact', 'update', { id, region: 'bc' }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('single-record read by id is denied for out-of-scope rows', async () => {
    const { runtime } = await bootstrap();
    const id = await seedContact(runtime, 'Bob', 'bc');
    const r = await dispatch(runtime, 'contact', 'read', { id }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('single-record read by id is allowed for in-scope rows', async () => {
    const { runtime } = await bootstrap();
    const id = await seedContact(runtime, 'Alice', 'alberta');
    const r = await dispatch(runtime, 'contact', 'read', { id }, albertaLead);
    expect(r.ok).toBe(true);
  });
});

// ── Mixed tier ──────────────────────────────────────────────────

describe('scope-enforce — mixed tier', () => {
  test('lead sees system rows + their region rows', async () => {
    const { runtime } = await bootstrap();
    await seedMilestone(runtime, 'UL 3700 published', null);     // system
    await seedMilestone(runtime, 'Calgary council vote', 'alberta');
    await seedMilestone(runtime, 'Vancouver pilot', 'bc');

    const r = await dispatch(runtime, 'milestone', 'read', {}, albertaLead);
    expect(r.ok).toBe(true);
    const titles = (r.data as { records: { title: string }[] }).records.map((x) => x.title).sort();
    expect(titles).toEqual(['Calgary council vote', 'UL 3700 published']);
  });

  test('user with no assignments still sees system rows', async () => {
    const { runtime } = await bootstrap();
    await seedMilestone(runtime, 'UL 3700 published', null);
    await seedMilestone(runtime, 'Calgary vote', 'alberta');

    const r = await dispatch(runtime, 'milestone', 'read', {}, noAssignments);
    expect(r.ok).toBe(true);
    const titles = (r.data as { records: { title: string }[] }).records.map((x) => x.title);
    expect(titles).toEqual(['UL 3700 published']);
  });

  test('non-sysadmin cannot create a system-tier (null region) milestone', async () => {
    const { runtime } = await bootstrap();
    const r = await dispatch(runtime, 'milestone', 'create', { title: 'rogue' }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('non-sysadmin cannot update a system-tier (null region) milestone', async () => {
    const { runtime } = await bootstrap();
    const id = await seedMilestone(runtime, 'UL 3700', null);
    const r = await dispatch(runtime, 'milestone', 'update', { id, title: 'Hijacked' }, albertaLead);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('auth-error');
  });

  test('lead can create a milestone in their region', async () => {
    const { runtime } = await bootstrap();
    const r = await dispatch(runtime, 'milestone', 'create', { title: 'Calgary vote', region: 'alberta' }, albertaLead);
    expect(r.ok).toBe(true);
  });

  test('lead can update their own region milestone', async () => {
    const { runtime } = await bootstrap();
    const id = await seedMilestone(runtime, 'Calgary vote', 'alberta');
    const r = await dispatch(runtime, 'milestone', 'update', { id, title: 'Calgary vote (updated)' }, albertaLead);
    expect(r.ok).toBe(true);
  });

  test('sysadmin can read everything', async () => {
    const { runtime } = await bootstrap();
    await seedMilestone(runtime, 'global', null);
    await seedMilestone(runtime, 'ab', 'alberta');
    await seedMilestone(runtime, 'bc', 'bc');

    const r = await dispatch(runtime, 'milestone', 'read', {}, sysadmin);
    expect(r.ok).toBe(true);
    expect((r.data as { records: unknown[] }).records.length).toBe(3);
  });
});
