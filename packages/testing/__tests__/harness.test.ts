/**
 * Tests for createTestHarness() and proof entities.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, clearRegistry } from '@janus/core';
import type { ReadPage } from '@janus/core';
import { Str, Int, Lifecycle, Persistent, AuditFull } from '@janus/vocabulary';
import { createTestHarness, proofEntities } from '..';

afterEach(() => clearRegistry());

// ── Basic harness ──────────────────────────────────────────────

describe('createTestHarness()', () => {
  test('creates a working harness with inline entities', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, {})],
    });

    const resp = await h.dispatch('note', 'create', { title: 'Hello' });
    expect(resp.ok).toBe(true);

    const id = (resp.data as { id: string }).id;
    const read = await h.dispatch('note', 'read', { id });
    expect(read.ok).toBe(true);
    expect((read.data as Record<string, unknown>).title).toBe('Hello');

    h.teardown();
  });

  test('captures broker events', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, {})],
    });

    await h.dispatch('note', 'create', { title: 'Test' });

    expect(h.events.length).toBeGreaterThan(0);
    expect(h.events.some((e) => e.entity === 'note')).toBe(true);

    h.teardown();
  });

  test('resetEvents() clears captured events', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, {})],
    });

    await h.dispatch('note', 'create', { title: 'Test' });
    expect(h.events.length).toBeGreaterThan(0);

    h.resetEvents();
    expect(h.events).toHaveLength(0);

    h.teardown();
  });

  test('framework entities available by default', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, {})],
    });

    expect(h.registry.entity('execution_log')).toBeDefined();
    expect(h.registry.entity('template')).toBeDefined();

    h.teardown();
  });

  test('includeFramework: false omits framework entities', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, {})],
      includeFramework: false,
    });

    expect(h.registry.entity('execution_log')).toBeUndefined();

    h.teardown();
  });

  test('custom identity used by default', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, {})],
      defaultIdentity: { id: 'alice', roles: ['admin'] },
    });

    const resp = await h.dispatch('note', 'create', { title: 'Test' });
    expect((resp.data as Record<string, unknown>).createdBy).toBe('alice');

    h.teardown();
  });

  test('dispatch identity override', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, {})],
    });

    const resp = await h.dispatch('note', 'create', { title: 'Test' }, { id: 'bob', roles: ['user'] });
    expect((resp.data as Record<string, unknown>).createdBy).toBe('bob');

    h.teardown();
  });

  test('audit works when configured via participate', async () => {
    const note = define('note', {
      schema: { title: Str({ required: true }) },
      storage: Persistent(),
    });
    const h = await createTestHarness({
      declarations: [note, participate(note, { audit: AuditFull })],
    });

    await h.dispatch('note', 'create', { title: 'Audited' });

    const logResp = await h.dispatch('execution_log', 'read', {});
    const page = logResp.data as ReadPage;
    const auditEntries = page.records.filter((r) => r.handler === 'audit-relational');
    expect(auditEntries.length).toBeGreaterThan(0);

    h.teardown();
  });
});

// ── Proof entities ─────────────────────────────────────────────

describe('proof entities', () => {
  test('all proof entities compile and CRUD works', async () => {
    const h = await createTestHarness({ declarations: proofEntities });

    // Create a user
    const userResp = await h.dispatch('user', 'create', { name: 'Alice', role: 'admin' });
    expect(userResp.ok).toBe(true);
    const userId = (userResp.data as { id: string }).id;

    // Create a venue
    const venueResp = await h.dispatch('venue', 'create', { name: 'Hall A', capacity: 100 });
    expect(venueResp.ok).toBe(true);
    const venueId = (venueResp.data as { id: string }).id;

    // Create an event linked to venue and user
    const eventResp = await h.dispatch('event_proof', 'create', {
      title: 'Workshop', venue: venueId, organizer: userId,
    });
    expect(eventResp.ok).toBe(true);

    // Create a note
    const noteResp = await h.dispatch('note', 'create', { title: 'Meeting notes', author: userId });
    expect(noteResp.ok).toBe(true);

    // Read back
    const users = await h.dispatch('user', 'read', {});
    expect(users.ok).toBe(true);
    expect((users.data as ReadPage).records).toHaveLength(1);

    h.teardown();
  });

  test('wiring effects work with proof entities', async () => {
    const h = await createTestHarness({ declarations: proofEntities });

    const userResp = await h.dispatch('user', 'create', { name: 'Alice' });
    const userId = (userResp.data as { id: string }).id;

    await h.dispatch('note', 'create', { title: 'Note 1', author: userId });
    await h.dispatch('note', 'create', { title: 'Note 2', author: userId });

    // Delete user — cascade deletes notes
    const del = await h.dispatch('user', 'delete', { id: userId });
    expect(del.ok).toBe(true);

    const notes = await h.dispatch('note', 'read', {});
    expect((notes.data as ReadPage).records).toHaveLength(0);

    h.teardown();
  });

  test('lifecycle transitions work with proof entities', async () => {
    const h = await createTestHarness({ declarations: proofEntities });

    const userResp = await h.dispatch('user', 'create', { name: 'Alice' });
    const userId = (userResp.data as { id: string }).id;

    // Transition user to suspended
    const suspend = await h.dispatch('user', 'update', { id: userId, status: 'suspended' });
    expect(suspend.ok).toBe(true);

    const read = await h.dispatch('user', 'read', { id: userId });
    expect((read.data as Record<string, unknown>).status).toBe('suspended');

    h.teardown();
  });

  test('restrict effect blocks delete on proof entities', async () => {
    const h = await createTestHarness({ declarations: proofEntities });

    const venueResp = await h.dispatch('venue', 'create', { name: 'Hall A' });
    const venueId = (venueResp.data as { id: string }).id;

    await h.dispatch('event_proof', 'create', { title: 'Workshop', venue: venueId });

    // Delete venue — should be blocked (event references it with restrict)
    const del = await h.dispatch('venue', 'delete', { id: venueId });
    expect(del.ok).toBe(false);
    expect(del.error?.kind).toBe('restrict-violation');

    h.teardown();
  });
});
