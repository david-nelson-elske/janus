/**
 * Unit tests for connector merge utilities — per-field ownership
 * for bidirectional sync (ADR 07c).
 *
 * Exercises: mergeOnIngest, filterForDistribute, isPingPong.
 */

import { describe, expect, test } from 'bun:test';
import { mergeOnIngest, filterForDistribute, isPingPong } from '..';

// ── mergeOnIngest ──────────────────────────────────────────────

describe('mergeOnIngest()', () => {
  test('no ownership map: all external fields overwrite local', () => {
    const local = { id: 'x', name: 'Old', email: 'old@test.com' };
    const external = { name: 'New', email: 'new@test.com' };

    const { merged, changed } = mergeOnIngest(local, external);

    expect(merged.name).toBe('New');
    expect(merged.email).toBe('new@test.com');
    expect(merged.id).toBe('x'); // preserved from local
    expect(changed).toContain('name');
    expect(changed).toContain('email');
  });

  test('with ownership: source fields overwrite, local fields kept', () => {
    const local = { id: 'x', name: 'Local Name', email: 'local@test.com', phone: '111' };
    const external = { name: 'External Name', email: 'ext@test.com', phone: '222' };
    const ownership = { name: 'source' as const, email: 'local' as const, phone: 'source' as const };

    const { merged } = mergeOnIngest(local, external, ownership);

    expect(merged.name).toBe('External Name'); // source-owned → overwritten
    expect(merged.email).toBe('local@test.com'); // local-owned → kept
    expect(merged.phone).toBe('222'); // source-owned → overwritten
  });

  test('reserved fields (id, _version, createdAt, etc.) never merged', () => {
    const local = { id: 'x', _version: 1, createdAt: '2026-01-01', name: 'A' };
    const external = { id: 'y', _version: 99, createdAt: '2099-01-01', name: 'B' };

    const { merged } = mergeOnIngest(local, external);

    expect(merged.id).toBe('x');
    expect(merged._version).toBe(1);
    expect(merged.createdAt).toBe('2026-01-01');
    expect(merged.name).toBe('B');
  });

  test('tracks changed fields correctly', () => {
    const local = { name: 'Same', email: 'old@test.com' };
    const external = { name: 'Same', email: 'new@test.com' };

    const { changed } = mergeOnIngest(local, external);

    expect(changed).not.toContain('name');
    expect(changed).toContain('email');
  });

  test('unspecified fields in ownership map are treated as source-owned', () => {
    const local = { name: 'Old', phone: '111' };
    const external = { name: 'New', phone: '222' };
    const ownership = { name: 'local' as const };
    // phone is not in ownership → treated as source-owned

    const { merged } = mergeOnIngest(local, external, ownership);

    expect(merged.name).toBe('Old'); // local-owned → kept
    expect(merged.phone).toBe('222'); // unspecified → source-owned → overwritten
  });
});

// ── filterForDistribute ────────────────────────────────────────

describe('filterForDistribute()', () => {
  test('no ownership map: all non-reserved fields included', () => {
    const record = { id: 'x', _version: 1, name: 'Alice', email: 'a@b.com' };

    const { fields, hasPushableFields } = filterForDistribute(record);

    expect(fields.name).toBe('Alice');
    expect(fields.email).toBe('a@b.com');
    expect(fields.id).toBeUndefined();
    expect(fields._version).toBeUndefined();
    expect(hasPushableFields).toBe(true);
  });

  test('with ownership: local fields included, source fields excluded', () => {
    const record = { id: 'x', name: 'Alice', email: 'a@b.com', phone: '111' };
    const ownership = { name: 'local' as const, email: 'source' as const, phone: 'local' as const };

    const { fields } = filterForDistribute(record, ownership);

    expect(fields.name).toBe('Alice');
    expect(fields.phone).toBe('111');
    expect(fields.email).toBeUndefined();
  });

  test('reserved fields excluded', () => {
    const record = {
      id: 'x', _version: 1, createdAt: 'ts', createdBy: 'u', updatedAt: 'ts',
      updatedBy: 'u', _deletedAt: null, name: 'Alice',
    };

    const { fields } = filterForDistribute(record);

    expect(fields.id).toBeUndefined();
    expect(fields._version).toBeUndefined();
    expect(fields.createdAt).toBeUndefined();
    expect(fields.createdBy).toBeUndefined();
    expect(fields.updatedAt).toBeUndefined();
    expect(fields.updatedBy).toBeUndefined();
    expect(fields._deletedAt).toBeUndefined();
    expect(fields.name).toBe('Alice');
  });

  test('hasPushableFields is true when there are pushable fields', () => {
    const record = { id: 'x', name: 'Alice' };
    const { hasPushableFields } = filterForDistribute(record);
    expect(hasPushableFields).toBe(true);
  });

  test('hasPushableFields is false when all fields are source-owned or reserved', () => {
    const record = { id: 'x', name: 'Alice' };
    const ownership = { name: 'source' as const };

    const { hasPushableFields } = filterForDistribute(record, ownership);
    expect(hasPushableFields).toBe(false);
  });

  test('unspecified fields in ownership map are treated as local-owned', () => {
    const record = { id: 'x', name: 'Alice', phone: '111' };
    const ownership = { name: 'source' as const };
    // phone is not in ownership → treated as local-owned → included

    const { fields } = filterForDistribute(record, ownership);

    expect(fields.name).toBeUndefined(); // source → excluded
    expect(fields.phone).toBe('111'); // unspecified → local → included
  });
});

// ── isPingPong ─────────────────────────────────────────────────

describe('isPingPong()', () => {
  test('returns false when no watermark', () => {
    expect(isPingPong(null, '2026-04-01T00:00:00Z')).toBe(false);
    expect(isPingPong(undefined, '2026-04-01T00:00:00Z')).toBe(false);
  });

  test('returns true when externalTimestamp <= watermark', () => {
    expect(isPingPong('2026-04-05T12:00:00Z', '2026-04-05T12:00:00Z')).toBe(true);
    expect(isPingPong('2026-04-05T12:00:00Z', '2026-04-05T11:00:00Z')).toBe(true);
  });

  test('returns false when externalTimestamp > watermark', () => {
    expect(isPingPong('2026-04-05T12:00:00Z', '2026-04-05T13:00:00Z')).toBe(false);
  });
});
