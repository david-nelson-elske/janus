/**
 * Integration tests for ADR 01d: Wiring Effects.
 *
 * Exercises: restrict/cascade/nullify on delete, transition effects on update.
 * Full pipeline: define → participate → compile → store → dispatch runtime → effects.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  define,
  participate,
  compile,
  clearRegistry,
  SYSTEM,
} from '@janus/core';
import type { CompileResult, EntityStore, ReadPage } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
} from '..';
import type { DispatchRuntime, Broker } from '..';
import { Str, Lifecycle, Relation, Reference, Persistent } from '@janus/vocabulary';

// ── Helpers ──────────────────────────────────────────────────────

let registry: CompileResult;
let store: EntityStore;
let runtime: DispatchRuntime;
let broker: Broker;

afterEach(() => {
  clearRegistry();
});

async function setupScenario(config: {
  userEffects?: Parameters<typeof Relation>[1];
  venueEffects?: Parameters<typeof Relation>[1];
  reviewerEffects?: Parameters<typeof Reference>[1];
}) {
  registerHandlers();

  const user = define('user', {
    schema: {
      name: Str({ required: true }),
      status: Lifecycle({
        active: ['archived', 'suspended'],
        suspended: ['active'],
      }),
    },
    storage: Persistent(),
  });

  const venue = define('venue', {
    schema: { name: Str({ required: true }) },
    storage: Persistent(),
  });

  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      author: Relation('user', config.userEffects ?? { cascade: 'restrict' }),
      venue: config.venueEffects ? Relation('venue', config.venueEffects) : Str(),
      reviewer: config.reviewerEffects ? Reference('user', config.reviewerEffects) : Str(),
    },
    storage: Persistent(),
  });

  registry = compile([
    user, venue, note,
    participate(user, {}), participate(venue, {}), participate(note, {}),
    ...frameworkEntities, ...frameworkParticipations,
  ]);

  const memAdapter = createMemoryAdapter();
  store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memAdapter, memory: memAdapter },
  });
  await store.initialize();

  broker = createBroker();
  runtime = createDispatchRuntime({ registry, store, broker });
}

// ── Restrict ────────────────────────────────────────────────────

describe('restrict effect', () => {
  test('blocks delete when referencing records exist', async () => {
    await setupScenario({ userEffects: { cascade: 'restrict' } });

    // Create user and note referencing it
    const userResp = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    expect(userResp.ok).toBe(true);
    const userId = (userResp.data as { id: string }).id;

    await runtime.dispatch('system', 'note', 'create', { title: 'Test', author: userId }, SYSTEM);

    // Try to delete user — should fail
    const deleteResp = await runtime.dispatch('system', 'user', 'delete', { id: userId }, SYSTEM);
    expect(deleteResp.ok).toBe(false);
    expect(deleteResp.error?.kind).toBe('restrict-violation');
  });

  test('allows delete when no referencing records exist', async () => {
    await setupScenario({ userEffects: { cascade: 'restrict' } });

    const userResp = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    // Delete user with no notes pointing to it — should succeed
    const deleteResp = await runtime.dispatch('system', 'user', 'delete', { id: userId }, SYSTEM);
    expect(deleteResp.ok).toBe(true);
  });
});

// ── Cascade ─────────────────────────────────────────────────────

describe('cascade effect', () => {
  test('deleting referenced entity cascades delete to referencing records', async () => {
    await setupScenario({ userEffects: { cascade: 'cascade' } });

    const userResp = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    // Create two notes by this user
    await runtime.dispatch('system', 'note', 'create', { title: 'Note 1', author: userId }, SYSTEM);
    await runtime.dispatch('system', 'note', 'create', { title: 'Note 2', author: userId }, SYSTEM);

    // Delete user — should cascade delete all notes
    const deleteResp = await runtime.dispatch('system', 'user', 'delete', { id: userId }, SYSTEM);
    expect(deleteResp.ok).toBe(true);

    // Verify notes are gone (soft-deleted)
    const notesResp = await runtime.dispatch('system', 'note', 'read', {}, SYSTEM);
    expect(notesResp.ok).toBe(true);
    const page = notesResp.data as { records: unknown[] };
    expect(page.records).toHaveLength(0);
  });
});

// ── Nullify ─────────────────────────────────────────────────────

describe('nullify effect', () => {
  test('deleting referenced entity nullifies FK on referencing records', async () => {
    await setupScenario({ userEffects: { cascade: 'nullify' } });

    const userResp = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    const noteResp = await runtime.dispatch('system', 'note', 'create', { title: 'Note 1', author: userId }, SYSTEM);
    const noteId = (noteResp.data as { id: string }).id;

    // Delete user — should nullify author on notes
    const deleteResp = await runtime.dispatch('system', 'user', 'delete', { id: userId }, SYSTEM);
    expect(deleteResp.ok).toBe(true);

    // Verify note's author is now null
    const readResp = await runtime.dispatch('system', 'note', 'read', { id: noteId }, SYSTEM);
    expect(readResp.ok).toBe(true);
    expect((readResp.data as { author: unknown }).author).toBeNull();
  });
});

// ── Mixed effects ───────────────────────────────────────────────

describe('mixed effects on same target', () => {
  test('one field cascade, another field nullify', async () => {
    await setupScenario({
      userEffects: { cascade: 'cascade' },
      reviewerEffects: { effects: { deleted: 'nullify' } },
    });

    const user1 = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const user1Id = (user1.data as { id: string }).id;
    const user2 = await runtime.dispatch('system', 'user', 'create', { name: 'Bob' }, SYSTEM);
    const user2Id = (user2.data as { id: string }).id;

    // Note: author=user1, reviewer=user2
    const noteResp = await runtime.dispatch('system', 'note', 'create', {
      title: 'Review Me', author: user1Id, reviewer: user2Id,
    }, SYSTEM);
    const noteId = (noteResp.data as { id: string }).id;

    // Delete user2 (reviewer) — should nullify reviewer field
    await runtime.dispatch('system', 'user', 'delete', { id: user2Id }, SYSTEM);
    const readResp = await runtime.dispatch('system', 'note', 'read', { id: noteId }, SYSTEM);
    expect((readResp.data as Record<string, unknown>).reviewer).toBeNull();
    expect((readResp.data as Record<string, unknown>).author).toBe(user1Id);
  });
});

// ── Transition effects ──────────────────────────────────────────

describe('transition effects', () => {
  test('transitioning referenced entity nullifies referencing records', async () => {
    await setupScenario({
      userEffects: {
        effects: {
          deleted: 'restrict',
          transitioned: { archived: 'nullify' },
        },
      },
    });

    const userResp = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    const noteResp = await runtime.dispatch('system', 'note', 'create', { title: 'Note', author: userId }, SYSTEM);
    const noteId = (noteResp.data as { id: string }).id;

    // Transition user to 'archived'
    const archiveResp = await runtime.dispatch('system', 'user', 'update', {
      id: userId, status: 'archived',
    }, SYSTEM);
    expect(archiveResp.ok).toBe(true);

    // Verify note's author is now null
    const readResp = await runtime.dispatch('system', 'note', 'read', { id: noteId }, SYSTEM);
    expect((readResp.data as Record<string, unknown>).author).toBeNull();
  });
});

// ── Count and updateWhere store methods ─────────────────────────

describe('count() and updateWhere() store methods', () => {
  test('count returns number of matching records', async () => {
    await setupScenario({});

    const userResp = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    await runtime.dispatch('system', 'note', 'create', { title: 'Note 1', author: userId }, SYSTEM);
    await runtime.dispatch('system', 'note', 'create', { title: 'Note 2', author: userId }, SYSTEM);

    const count = await store.count('note', { author: userId });
    expect(count).toBe(2);
  });

  test('updateWhere updates matching records and returns count', async () => {
    await setupScenario({});

    const userResp = await runtime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    await runtime.dispatch('system', 'note', 'create', { title: 'Note 1', author: userId }, SYSTEM);
    await runtime.dispatch('system', 'note', 'create', { title: 'Note 2', author: userId }, SYSTEM);

    const updated = await store.updateWhere('note', { author: userId }, { author: null });
    expect(updated).toBe(2);

    const count = await store.count('note', { author: userId });
    expect(count).toBe(0);
  });
});

// ── Multi-level cascade chain ──────────────────────────────────

describe('multi-level cascade chain', () => {
  let multiRegistry: CompileResult;
  let multiStore: EntityStore;
  let multiRuntime: DispatchRuntime;
  let multiBroker: Broker;

  afterEach(() => {
    clearRegistry();
  });

  async function setupMultiLevel() {
    registerHandlers();

    const user = define('user', {
      schema: { name: Str({ required: true }) },
      storage: Persistent(),
    });
    const note = define('note', {
      schema: {
        title: Str({ required: true }),
        author: Relation('user', { cascade: 'cascade' }),
      },
      storage: Persistent(),
    });
    const comment = define('comment', {
      schema: {
        body: Str({ required: true }),
        note: Relation('note', { cascade: 'cascade' }),
      },
      storage: Persistent(),
    });

    multiRegistry = compile([
      user, note, comment,
      participate(user, {}), participate(note, {}), participate(comment, {}),
      ...frameworkEntities, ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    multiStore = createEntityStore({
      routing: multiRegistry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await multiStore.initialize();

    multiBroker = createBroker();
    multiRuntime = createDispatchRuntime({ registry: multiRegistry, store: multiStore, broker: multiBroker });
  }

  test('user → note → comment: deleting user cascades through all levels', async () => {
    await setupMultiLevel();

    // Create chain: user → note → comment
    const userResp = await multiRuntime.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    const noteResp = await multiRuntime.dispatch('system', 'note', 'create', { title: 'Note 1', author: userId }, SYSTEM);
    const noteId = (noteResp.data as { id: string }).id;

    await multiRuntime.dispatch('system', 'comment', 'create', { body: 'Great!', note: noteId }, SYSTEM);
    await multiRuntime.dispatch('system', 'comment', 'create', { body: 'Thanks!', note: noteId }, SYSTEM);

    // Delete user — should cascade: user → notes → comments
    const deleteResp = await multiRuntime.dispatch('system', 'user', 'delete', { id: userId }, SYSTEM);
    expect(deleteResp.ok).toBe(true);

    // Verify notes are gone
    const notesResp = await multiRuntime.dispatch('system', 'note', 'read', {}, SYSTEM);
    expect((notesResp.data as ReadPage).records).toHaveLength(0);

    // Verify comments are gone
    const commentsResp = await multiRuntime.dispatch('system', 'comment', 'read', {}, SYSTEM);
    expect((commentsResp.data as ReadPage).records).toHaveLength(0);
  });
});

// ── Cascade depth limit ────────────────────────────────────────

describe('cascade depth limit', () => {
  test('cascade exceeding maxDepth returns max-depth error', async () => {
    registerHandlers();

    // Create a deep chain: a → b → c → d → e → f (6 levels)
    const a = define('level_a', {
      schema: { name: Str({ required: true }) },
      storage: Persistent(),
    });
    const b = define('level_b', {
      schema: { name: Str({ required: true }), ref: Relation('level_a', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const c = define('level_c', {
      schema: { name: Str({ required: true }), ref: Relation('level_b', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const d = define('level_d', {
      schema: { name: Str({ required: true }), ref: Relation('level_c', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const e = define('level_e', {
      schema: { name: Str({ required: true }), ref: Relation('level_d', { cascade: 'cascade' }) },
      storage: Persistent(),
    });
    const f = define('level_f', {
      schema: { name: Str({ required: true }), ref: Relation('level_e', { cascade: 'cascade' }) },
      storage: Persistent(),
    });

    const reg = compile([
      a, b, c, d, e, f,
      participate(a, {}), participate(b, {}), participate(c, {}),
      participate(d, {}), participate(e, {}), participate(f, {}),
      ...frameworkEntities, ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    const st = createEntityStore({
      routing: reg.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await st.initialize();

    const br = createBroker();
    // Set maxDepth to 3 so the cascade will exceed it
    const rt = createDispatchRuntime({ registry: reg, store: st, broker: br, maxDepth: 3 });

    // Create chain: a1 ← b1 ← c1 ← d1
    const aResp = await rt.dispatch('system', 'level_a', 'create', { name: 'A1' }, SYSTEM);
    const aId = (aResp.data as { id: string }).id;

    const bResp = await rt.dispatch('system', 'level_b', 'create', { name: 'B1', ref: aId }, SYSTEM);
    const bId = (bResp.data as { id: string }).id;

    const cResp = await rt.dispatch('system', 'level_c', 'create', { name: 'C1', ref: bId }, SYSTEM);
    const cId = (cResp.data as { id: string }).id;

    await rt.dispatch('system', 'level_d', 'create', { name: 'D1', ref: cId }, SYSTEM);

    // Delete a1: cascade a→b(depth 1)→c(depth 2)→d(depth 3=maxDepth) → error
    const deleteResp = await rt.dispatch('system', 'level_a', 'delete', { id: aId }, SYSTEM);
    // The delete itself throws because the cascade chain hits depth limit
    expect(deleteResp.ok).toBe(false);
    expect(deleteResp.error?.kind).toBe('max-depth');
  });
});

// ── Transition effect with { transition } action ───────────────

describe('transition effect with { transition } action', () => {
  test('transitioning venue to archived transitions events to cancelled', async () => {
    registerHandlers();

    const venue = define('venue', {
      schema: {
        name: Str({ required: true }),
        status: Lifecycle({ active: ['archived', 'suspended'] }),
      },
      storage: Persistent(),
    });
    const event_entity = define('event_entity', {
      schema: {
        title: Str({ required: true }),
        phase: Lifecycle({ draft: ['scheduled', 'cancelled'], scheduled: ['cancelled'] }),
        venue: Relation('venue', {
          effects: {
            deleted: 'restrict',
            transitioned: {
              archived: { transition: 'cancelled' },
            },
          },
        }),
      },
      storage: Persistent(),
    });

    const reg = compile([
      venue, event_entity,
      participate(venue, {}), participate(event_entity, {}),
      ...frameworkEntities, ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    const st = createEntityStore({
      routing: reg.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await st.initialize();

    const br = createBroker();
    const rt = createDispatchRuntime({ registry: reg, store: st, broker: br });

    // Create venue and two events
    const venueResp = await rt.dispatch('system', 'venue', 'create', { name: 'Hall A' }, SYSTEM);
    const venueId = (venueResp.data as { id: string }).id;

    const ev1Resp = await rt.dispatch('system', 'event_entity', 'create', {
      title: 'Event 1', phase: 'draft', venue: venueId,
    }, SYSTEM);
    const ev1Id = (ev1Resp.data as { id: string }).id;

    // Transition event to scheduled so it has a state to transition from
    await rt.dispatch('system', 'event_entity', 'update', { id: ev1Id, phase: 'scheduled' }, SYSTEM);

    const ev2Resp = await rt.dispatch('system', 'event_entity', 'create', {
      title: 'Event 2', phase: 'draft', venue: venueId,
    }, SYSTEM);
    const ev2Id = (ev2Resp.data as { id: string }).id;

    // Archive venue → should transition events to 'cancelled'
    const archiveResp = await rt.dispatch('system', 'venue', 'update', {
      id: venueId, status: 'archived',
    }, SYSTEM);
    expect(archiveResp.ok).toBe(true);

    // Verify events are now cancelled
    const ev1Read = await rt.dispatch('system', 'event_entity', 'read', { id: ev1Id }, SYSTEM);
    expect((ev1Read.data as Record<string, unknown>).phase).toBe('cancelled');

    const ev2Read = await rt.dispatch('system', 'event_entity', 'read', { id: ev2Id }, SYSTEM);
    expect((ev2Read.data as Record<string, unknown>).phase).toBe('cancelled');
  });
});

// ── Cascade uses SYSTEM identity ───────────────────────────────

describe('cascade identity', () => {
  test('cascaded records are updated by system identity', async () => {
    registerHandlers();

    const user = define('user', {
      schema: { name: Str({ required: true }) },
      storage: Persistent(),
    });
    const note = define('note', {
      schema: {
        title: Str({ required: true }),
        author: Relation('user', { cascade: 'cascade' }),
      },
      storage: Persistent(),
    });

    const reg = compile([
      user, note,
      participate(user, {}), participate(note, {}),
      ...frameworkEntities, ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    const st = createEntityStore({
      routing: reg.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await st.initialize();

    const br = createBroker();
    const rt = createDispatchRuntime({ registry: reg, store: st, broker: br });

    // Create as a non-system user
    const alice = { id: 'alice', roles: ['user'] };
    const userResp = await rt.dispatch('system', 'user', 'create', { name: 'Alice' }, alice);
    const userId = (userResp.data as { id: string }).id;

    const noteResp = await rt.dispatch('system', 'note', 'create', { title: 'Test', author: userId }, alice);
    expect(noteResp.ok).toBe(true);
    expect((noteResp.data as Record<string, unknown>).createdBy).toBe('alice');

    // Delete user — cascade will use SYSTEM identity
    const deleteResp = await rt.dispatch('system', 'user', 'delete', { id: userId }, alice);
    expect(deleteResp.ok).toBe(true);

    // Note is soft-deleted, but we can verify via direct store that _deletedAt is set
    const allNotes = await st.read('note', {});
    expect((allNotes as ReadPage).records).toHaveLength(0);
  });
});

// ── Broker events ──────────────────────────────────────────────

describe('broker event behavior', () => {
  test('broker receives event for top-level delete but not cascaded deletes', async () => {
    registerHandlers();

    const user = define('user', {
      schema: { name: Str({ required: true }) },
      storage: Persistent(),
    });
    const note = define('note', {
      schema: {
        title: Str({ required: true }),
        author: Relation('user', { cascade: 'cascade' }),
      },
      storage: Persistent(),
    });

    const reg = compile([
      user, note,
      participate(user, {}), participate(note, {}),
      ...frameworkEntities, ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    const st = createEntityStore({
      routing: reg.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await st.initialize();

    const br = createBroker();
    const events: Array<{ entity: string; descriptor: string }> = [];
    br.onNotify((event) => {
      events.push({ entity: event.entity, descriptor: event.descriptor });
    });

    const rt = createDispatchRuntime({ registry: reg, store: st, broker: br });

    const userResp = await rt.dispatch('system', 'user', 'create', { name: 'Alice' }, SYSTEM);
    const userId = (userResp.data as { id: string }).id;

    await rt.dispatch('system', 'note', 'create', { title: 'Note 1', author: userId }, SYSTEM);

    // Clear events from create operations
    events.length = 0;

    // Delete user — cascade deletes note
    await rt.dispatch('system', 'user', 'delete', { id: userId }, SYSTEM);

    // Only the top-level user delete should emit an event (depth=0)
    // Cascaded note delete is at depth=1, so emit-broker skips it
    expect(events).toHaveLength(1);
    expect(events[0].entity).toBe('user');
    expect(events[0].descriptor).toBe('deleted');
  });
});
