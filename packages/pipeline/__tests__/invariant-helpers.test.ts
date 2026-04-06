/**
 * Integration tests for TimeGate and FieldCompare invariant helpers
 * exercised through the full dispatch pipeline.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  define,
  participate,
  compile,
  clearRegistry,
  TimeGate,
  FieldCompare,
  Hours,
} from '@janus/core';
import { Str, DateTime, Persistent } from '@janus/vocabulary';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import { registerHandlers, createDispatchRuntime } from '..';

afterEach(() => {
  clearRegistry();
});

describe('FieldCompare in pipeline', () => {
  test('rejects create when start >= end', async () => {
    registerHandlers();

    const event = define('event', {
      storage: Persistent(),
      schema: {
        title: Str({ required: true }),
        startsAt: DateTime(),
        endsAt: DateTime(),
      },
    });
    const eventP = participate(event, {
      invariant: [FieldCompare('startsAt', 'lt', 'endsAt')],
    });

    const compiled = compile([event, eventP]);
    const mem = createMemoryAdapter();
    const store = createEntityStore({
      routing: compiled.persistRouting,
      adapters: { relational: mem, memory: mem },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: compiled, store });

    // Valid: start < end
    const good = await runtime.dispatch('system', 'event', 'create', {
      title: 'Valid',
      startsAt: '2026-06-01T10:00:00Z',
      endsAt: '2026-06-01T12:00:00Z',
    });
    expect(good.ok).toBe(true);

    // Invalid: start > end
    const bad = await runtime.dispatch('system', 'event', 'create', {
      title: 'Invalid',
      startsAt: '2026-06-01T14:00:00Z',
      endsAt: '2026-06-01T12:00:00Z',
    });
    expect(bad.ok).toBe(false);
    expect(bad.error?.kind).toBe('invariant-violation');
  });
});

describe('TimeGate in pipeline', () => {
  test('rejects create when datetime is too soon', async () => {
    registerHandlers();

    const booking = define('booking', {
      storage: Persistent(),
      schema: {
        title: Str({ required: true }),
        startsAt: DateTime(),
      },
    });
    const bookingP = participate(booking, {
      invariant: [TimeGate('startsAt', Hours(24))],
    });

    const compiled = compile([booking, bookingP]);
    const mem = createMemoryAdapter();
    const store = createEntityStore({
      routing: compiled.persistRouting,
      adapters: { relational: mem, memory: mem },
    });
    await store.initialize();
    const runtime = createDispatchRuntime({ registry: compiled, store });

    // Valid: 48h from now
    const good = await runtime.dispatch('system', 'booking', 'create', {
      title: 'Valid',
      startsAt: new Date(Date.now() + Hours(48)).toISOString(),
    });
    expect(good.ok).toBe(true);

    // Invalid: 1h from now (need at least 24h)
    const bad = await runtime.dispatch('system', 'booking', 'create', {
      title: 'Too soon',
      startsAt: new Date(Date.now() + Hours(1)).toISOString(),
    });
    expect(bad.ok).toBe(false);
    expect(bad.error?.kind).toBe('invariant-violation');
  });
});
