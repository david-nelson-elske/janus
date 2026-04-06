/**
 * Narrative validation — proves the PCA cleanup event entities compile
 * and dispatch correctly with the current framework.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { define, participate, compile, clearRegistry } from '@janus/core';
import type { CompileResult } from '@janus/core';
import {
  Str, Int, Markdown, DateTime, LatLng, Lifecycle, Relation, Persistent,
} from '@janus/vocabulary';
import { registerHandlers, createDispatchRuntime, createBroker } from '..';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import type { EntityStore } from '@janus/store';
import type { DispatchRuntime } from '..';

afterEach(() => clearRegistry());

function setupCleanupScenario() {
  registerHandlers();

  const event = define('event', {
    schema: {
      title: Str({ required: true }),
      description: Markdown(),
      date: DateTime({ required: true }),
      location: Str(),
      coordinates: LatLng(),
      organizer: Relation('volunteer'),
      status: Lifecycle({
        draft: ['published'],
        published: ['completed', 'cancelled'],
        completed: ['archived'],
        cancelled: ['archived'],
      }),
    },
    storage: Persistent(),
  });

  const shift = define('shift', {
    schema: {
      event: Relation('event'),
      name: Str({ required: true }),
      start_time: DateTime({ required: true }),
      end_time: DateTime({ required: true }),
      capacity: Int({ required: true }),
      filled: Int(),
      status: Lifecycle({
        open: ['filled', 'cancelled'],
        filled: ['open', 'cancelled'],
      }),
    },
    storage: Persistent(),
  });

  const registration = define('registration', {
    schema: {
      shift: Relation('shift'),
      volunteer: Relation('volunteer'),
      notes: Str(),
      status: Lifecycle({
        confirmed: ['cancelled'],
      }),
    },
    storage: Persistent(),
  });

  const volunteer = define('volunteer', {
    schema: {
      name: Str({ required: true }),
      email: Str({ required: true }),
      phone: Str(),
    },
    storage: Persistent(),
  });

  const eventP = participate(event, {});
  const shiftP = participate(shift, {});
  const registrationP = participate(registration, {});
  const volunteerP = participate(volunteer, {});

  const registry = compile([
    event, shift, registration, volunteer,
    eventP, shiftP, registrationP, volunteerP,
  ]);

  return registry;
}

describe('PCA cleanup event entities', () => {
  test('all four entities compile', () => {
    const registry = setupCleanupScenario();
    expect(registry.graphNodes.size).toBe(4);
    expect(registry.entity('event')).toBeDefined();
    expect(registry.entity('shift')).toBeDefined();
    expect(registry.entity('registration')).toBeDefined();
    expect(registry.entity('volunteer')).toBeDefined();
  });

  test('wiring graph connects correctly', () => {
    const registry = setupCleanupScenario();
    const edges = registry.wiring.edges;

    // shift → event
    expect(edges.find((e) => e.from === 'shift' && e.to === 'event')).toBeDefined();
    // registration → shift
    expect(edges.find((e) => e.from === 'registration' && e.to === 'shift')).toBeDefined();
    // registration → volunteer
    expect(edges.find((e) => e.from === 'registration' && e.to === 'volunteer')).toBeDefined();
    // event → volunteer (organizer)
    expect(edges.find((e) => e.from === 'event' && e.to === 'volunteer')).toBeDefined();
  });

  test('event has correct lifecycle transitions', () => {
    const registry = setupCleanupScenario();
    const event = registry.entity('event')!;

    expect(event.transitionTargets.map((t) => t.name)).toContain('published');
    expect(event.transitionTargets.map((t) => t.name)).toContain('completed');
    expect(event.transitionTargets.map((t) => t.name)).toContain('cancelled');
    expect(event.transitionTargets.map((t) => t.name)).toContain('archived');
  });

  test('dispatch index has pipelines for all entities', () => {
    const registry = setupCleanupScenario();

    expect(registry.pipeline('system', 'event', 'create')).toBeDefined();
    expect(registry.pipeline('system', 'shift', 'read')).toBeDefined();
    expect(registry.pipeline('system', 'registration', 'create')).toBeDefined();
    expect(registry.pipeline('system', 'volunteer', 'update')).toBeDefined();

    // Lifecycle transitions
    expect(registry.pipeline('system', 'event', 'published')).toBeDefined();
    expect(registry.pipeline('system', 'shift', 'filled')).toBeDefined();
    expect(registry.pipeline('system', 'registration', 'cancelled')).toBeDefined();
  });
});

describe('PCA cleanup event dispatch', () => {
  let store: EntityStore;
  let runtime: DispatchRuntime;

  test('full scenario: create event → shifts → volunteer → register → publish → complete', async () => {
    registerHandlers();
    const registry = setupCleanupScenario();

    const adapter = createMemoryAdapter();
    store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: adapter, memory: adapter },
    });
    await store.initialize();
    const broker = createBroker();
    runtime = createDispatchRuntime({ registry, store, broker });

    // 1. Create a volunteer (organizer)
    const orgRes = await runtime.dispatch('system', 'volunteer', 'create', {
      name: 'David', email: 'david@parkdale.ca',
    });
    expect(orgRes.ok).toBe(true);
    const organizerId = (orgRes.data as Record<string, unknown>).id;

    // 2. Create the event
    const eventRes = await runtime.dispatch('system', 'event', 'create', {
      title: 'Spring Cleanup 2026',
      description: 'Annual neighborhood cleanup at Riley Park',
      date: '2026-05-15T09:00:00Z',
      location: 'Riley Park',
      organizer: organizerId,
    });
    expect(eventRes.ok).toBe(true);
    const eventId = (eventRes.data as Record<string, unknown>).id;
    expect((eventRes.data as Record<string, unknown>).status).toBe('draft');

    // 3. Create morning shift
    const morningRes = await runtime.dispatch('system', 'shift', 'create', {
      event: eventId,
      name: 'Morning shift',
      start_time: '2026-05-15T09:00:00Z',
      end_time: '2026-05-15T12:00:00Z',
      capacity: 20,
    });
    expect(morningRes.ok).toBe(true);
    const morningShiftId = (morningRes.data as Record<string, unknown>).id;

    // 4. Publish the event (draft → published)
    const publishRes = await runtime.dispatch('system', 'event', 'published', { id: eventId });
    expect(publishRes.ok).toBe(true);
    expect((publishRes.data as Record<string, unknown>).status).toBe('published');

    // 5. Create a volunteer
    const volRes = await runtime.dispatch('system', 'volunteer', 'create', {
      name: 'Alice Chen', email: 'alice@example.com', phone: '555-1234',
    });
    expect(volRes.ok).toBe(true);
    const volunteerId = (volRes.data as Record<string, unknown>).id;

    // 6. Register for the morning shift
    const regRes = await runtime.dispatch('system', 'registration', 'create', {
      shift: morningShiftId,
      volunteer: volunteerId,
      notes: 'I can bring garbage bags',
    });
    expect(regRes.ok).toBe(true);
    expect((regRes.data as Record<string, unknown>).status).toBe('confirmed');

    // 7. Read all registrations
    const regsRes = await runtime.dispatch('system', 'registration', 'read', {});
    expect(regsRes.ok).toBe(true);
    expect(((regsRes.data as { records: unknown[] }).records)).toHaveLength(1);

    // 8. Complete the event (published → completed)
    const completeRes = await runtime.dispatch('system', 'event', 'completed', { id: eventId });
    expect(completeRes.ok).toBe(true);
    expect((completeRes.data as Record<string, unknown>).status).toBe('completed');

    // 9. Verify invalid transition (completed → published should fail)
    const badRes = await runtime.dispatch('system', 'event', 'published', { id: eventId });
    expect(badRes.ok).toBe(false);
    expect(badRes.error?.kind).toBe('lifecycle-violation');
  });
});
