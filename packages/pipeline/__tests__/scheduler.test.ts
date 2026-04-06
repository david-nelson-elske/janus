/**
 * Unit tests for startScheduler — cron-triggered subscription scheduler.
 *
 * Exercises: empty cron subs, stop(), drain().
 */

import { describe, expect, test } from 'bun:test';
import { startScheduler } from '..';
import type { CompileResult } from '@janus/core';

describe('startScheduler()', () => {
  test('no cron subscriptions returns handle with stop/drain', () => {
    const mockRegistry = {
      subscriptions: [],
    } as unknown as CompileResult;

    const handle = startScheduler({
      runtime: {} as any,
      store: {} as any,
      registry: mockRegistry,
    });

    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.drain).toBe('function');

    // Should not throw
    handle.stop();
  });

  test('stop() is idempotent', () => {
    const mockRegistry = {
      subscriptions: [],
    } as unknown as CompileResult;

    const handle = startScheduler({
      runtime: {} as any,
      store: {} as any,
      registry: mockRegistry,
    });

    handle.stop();
    handle.stop(); // second call should not throw
  });

  test('drain() resolves when no inflight', async () => {
    const mockRegistry = {
      subscriptions: [],
    } as unknown as CompileResult;

    const handle = startScheduler({
      runtime: {} as any,
      store: {} as any,
      registry: mockRegistry,
    });

    // Should resolve immediately with no cron subs
    await handle.drain();
    handle.stop();
  });

  test('only processes cron-triggered subscriptions', () => {
    const mockRegistry = {
      subscriptions: [
        { trigger: { kind: 'event', on: { kind: 'created' } }, source: 'note', handler: 'test' },
      ],
    } as unknown as CompileResult;

    // Event subs should be ignored by the scheduler (no timers created)
    const handle = startScheduler({
      runtime: {} as any,
      store: {} as any,
      registry: mockRegistry,
    });

    // Should not throw — no cron subs to schedule
    handle.stop();
  });
});
