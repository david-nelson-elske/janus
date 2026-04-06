/**
 * FieldState — Per-field reactive state using @preact/signals-core.
 *
 * Each field tracks a committed value (last persisted) and a current value
 * (live edits). The dirty signal is a computed derivation.
 */

import { signal, computed } from '@preact/signals-core';
import type { Signal, ReadonlySignal } from '@preact/signals-core';
import type { AgentInteractionLevel } from '@janus/core';

export interface FieldMeta {
  readonly type: string;                    // semantic type kind from schema
  readonly agent: AgentInteractionLevel;
  readonly component?: string;
  readonly label?: string;
}

export interface FieldState<T = unknown> {
  readonly committed: Signal<T>;            // last persisted value
  readonly current: Signal<T>;              // live value (user edits, agent writes)
  readonly dirty: ReadonlySignal<boolean>;  // committed !== current
  readonly meta: FieldMeta;
}

export function createFieldState<T>(value: T, meta: FieldMeta): FieldState<T> {
  const committed = signal(value);
  const current = signal(value);
  const dirty = computed(() => committed.value !== current.value);
  return { committed, current, dirty, meta };
}
