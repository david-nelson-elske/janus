/**
 * Tests for ADR 04c: Schema Reconciliation.
 *
 * Exercises: snapshot generation, four-tier classification, evolve config resolution,
 * reconciliation pipeline, SchemaReconciliationError.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Str, Int, Markdown, Lifecycle, Relation, Persistent } from '@janus/vocabulary';
import type { AdapterMeta } from '../store-adapter';
import { generateSnapshot, type EntitySnapshot, type FieldSnapshot } from '../schema-snapshot';
import { classifyChanges, SchemaReconciliationError } from '../schema-reconcile';
import type { EvolveConfig } from '@janus/core';

// ── Helpers ──────────────────────────────────────────────────────

function makeMeta(entity: string, schema: Record<string, unknown>): AdapterMeta {
  return {
    entity,
    table: entity,
    schema: schema as AdapterMeta['schema'],
    storage: Persistent(),
  };
}

function makeSnapshot(entity: string, fields: FieldSnapshot[]): EntitySnapshot {
  return { entity, table: entity, fields, version: 1, capturedAt: '2026-01-01T00:00:00Z' };
}

function field(name: string, kind = 'str', sqlType = 'TEXT', required = false): FieldSnapshot {
  return { name, kind, sqlType, required };
}

// ── Snapshot generation ─────────────────────────────────────────

describe('generateSnapshot()', () => {
  test('captures semantic fields', () => {
    const meta = makeMeta('note', { title: Str({ required: true }), count: Int() });
    const snap = generateSnapshot(meta);
    expect(snap.entity).toBe('note');
    expect(snap.fields).toHaveLength(2);
    expect(snap.fields.find((f) => f.name === 'title')?.required).toBe(true);
    expect(snap.fields.find((f) => f.name === 'count')?.sqlType).toBe('INTEGER');
  });

  test('captures lifecycle fields', () => {
    const meta = makeMeta('note', {
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
    });
    const snap = generateSnapshot(meta);
    expect(snap.fields[0].kind).toBe('lifecycle');
    expect(snap.fields[0].lifecycleStates).toContain('draft');
  });

  test('captures wiring fields', () => {
    const meta = makeMeta('note', { author: Relation('user') });
    const snap = generateSnapshot(meta);
    expect(snap.fields[0].kind).toBe('relation');
    expect(snap.fields[0].target).toBe('user');
  });
});

// ── Four-tier classification ────────────────────────────────────

describe('classifyChanges()', () => {
  test('new entity is safe', () => {
    const metas = [makeMeta('note', { title: Str() })];
    const snapshots: EntitySnapshot[] = [];
    const plan = classifyChanges(metas, snapshots, new Map(), new Set());

    expect(plan.safe).toHaveLength(1);
    expect(plan.safe[0].kind).toBe('add-entity');
    expect(plan.canAutoApply).toBe(true);
  });

  test('no change produces empty plan', () => {
    const metas = [makeMeta('note', { title: Str() })];
    const snap = generateSnapshot(metas[0]);
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    expect(plan.changes).toHaveLength(0);
    expect(plan.canAutoApply).toBe(true);
  });

  test('add nullable column is safe', () => {
    const metas = [makeMeta('note', { title: Str(), body: Markdown() })];
    const snap = makeSnapshot('note', [field('title')]);
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    expect(plan.safe).toHaveLength(1);
    expect(plan.safe[0].kind).toBe('add-column');
    expect(plan.safe[0].field).toBe('body');
    expect(plan.canAutoApply).toBe(true);
  });

  test('add required column without backfill is cautious', () => {
    const metas = [makeMeta('note', { title: Str({ required: true }), body: Str({ required: true }) })];
    const snap = makeSnapshot('note', [field('title', 'str', 'TEXT', true)]);
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    expect(plan.cautious).toHaveLength(1);
    expect(plan.cautious[0].field).toBe('body');
    expect(plan.canAutoApply).toBe(false);
  });

  test('add required column with backfill is safe', () => {
    const evolve: EvolveConfig = { backfills: { body: '' } };
    const metas = [makeMeta('note', { title: Str({ required: true }), body: Str({ required: true }) })];
    const snap = makeSnapshot('note', [field('title', 'str', 'TEXT', true)]);
    const plan = classifyChanges(metas, [snap], new Map([['note', evolve]]), new Set());

    // With backfill, required column becomes safe
    expect(plan.safe.some((c) => c.field === 'body')).toBe(true);
  });

  test('remove column without drops is ambiguous', () => {
    const metas = [makeMeta('note', { title: Str() })];
    const snap = makeSnapshot('note', [field('title'), field('body')]);
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].field).toBe('body');
    expect(plan.canAutoApply).toBe(false);
  });

  test('remove column with evolve.drops is destructive', () => {
    const evolve: EvolveConfig = { drops: ['body'] };
    const metas = [makeMeta('note', { title: Str() })];
    const snap = makeSnapshot('note', [field('title'), field('body')]);
    const plan = classifyChanges(metas, [snap], new Map([['note', evolve]]), new Set());

    expect(plan.destructive).toHaveLength(1);
    expect(plan.destructive[0].field).toBe('body');
  });

  test('rename with evolve.renames is cautious', () => {
    const evolve: EvolveConfig = { renames: { body: 'content' } };
    const metas = [makeMeta('note', { title: Str(), content: Str() })];
    const snap = makeSnapshot('note', [field('title'), field('body')]);
    const plan = classifyChanges(metas, [snap], new Map([['note', evolve]]), new Set());

    expect(plan.cautious.some((c) => c.kind === 'rename-column' && c.field === 'content')).toBe(true);
  });

  test('remove entity without drop() is ambiguous', () => {
    const metas: AdapterMeta[] = [];
    const snap = makeSnapshot('old_entity', [field('name')]);
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].kind).toBe('remove-entity');
  });

  test('remove entity with drop() is destructive', () => {
    const metas: AdapterMeta[] = [];
    const snap = makeSnapshot('old_entity', [field('name')]);
    const plan = classifyChanges(metas, [snap], new Map(), new Set(['old_entity']));

    expect(plan.destructive).toHaveLength(1);
    expect(plan.destructive[0].kind).toBe('remove-entity');
  });

  test('type change without coercion is ambiguous', () => {
    const metas = [makeMeta('note', { count: Int() })]; // INTEGER
    const snap = makeSnapshot('note', [field('count', 'str', 'TEXT')]); // was TEXT
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].kind).toBe('change-type');
  });

  test('mixed tiers block auto-apply', () => {
    const metas = [makeMeta('note', { title: Str(), newField: Str() })]; // safe: add newField
    const snap = makeSnapshot('note', [field('title'), field('removed')]); // ambiguous: removed gone
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    expect(plan.safe.length).toBeGreaterThan(0);
    expect(plan.ambiguous.length).toBeGreaterThan(0);
    expect(plan.canAutoApply).toBe(false);
  });
});

// ── SchemaReconciliationError ───────────────────────────────────

describe('SchemaReconciliationError', () => {
  test('error message includes all blocked changes', () => {
    const metas = [makeMeta('note', { title: Str() })];
    const snap = makeSnapshot('note', [field('title'), field('removed')]);
    const plan = classifyChanges(metas, [snap], new Map(), new Set());

    const error = new SchemaReconciliationError(plan);
    expect(error.message).toContain('AMBIGUOUS');
    expect(error.message).toContain('removed');
    expect(error.plan).toBe(plan);
  });
});

// ── drop() function ─────────────────────────────────────────────

describe('drop()', () => {
  test('drop produces correct declaration', async () => {
    const { drop } = await import('@janus/core');
    const result = drop('old_entity');
    expect(result.kind).toBe('drop');
    expect(result.entity).toBe('old_entity');
  });

  test('drop declarations compile without error', async () => {
    const { define, participate, compile, seedHandlers, clearRegistry, drop } = await import('@janus/core');
    clearRegistry();
    seedHandlers();

    const note = define('note', { schema: { title: Str() }, storage: Persistent() });
    const result = compile([note, participate(note, {}), drop('old_entity')]);
    expect(result.graphNodes.size).toBe(1);
  });
});
