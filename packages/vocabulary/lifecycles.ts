/**
 * Lifecycles — state machines that govern entity transitions.
 *
 * A lifecycle defines which states exist, which transitions are legal.
 * Auth and payment concerns moved to defineProjection() — the lifecycle is just the state machine.
 */

// ── Types ────────────────────────────────────────────────────────

/** State name → array of reachable state names. */
export type TransitionMap = Readonly<Record<string, readonly string[]>>;

export interface LifecycleDescriptor {
  readonly kind: 'lifecycle';
  readonly transitions: TransitionMap;
  readonly initial: string;
  readonly states: readonly string[];
  readonly terminalStates: readonly string[];
}

export interface NamedLifecycle extends LifecycleDescriptor {
  readonly name: string;
}

// ── Constructors ─────────────────────────────────────────────────

function buildLifecycle(transitions: TransitionMap): Omit<LifecycleDescriptor, 'kind'> {
  const keys = Object.keys(transitions);
  if (keys.length === 0) throw new Error('Lifecycle must have at least one state');

  const initial = keys[0];

  // Collect all unique states (sources + targets)
  const stateSet = new Set<string>();
  for (const source of keys) {
    stateSet.add(source);
    for (const target of transitions[source]) {
      stateSet.add(target);
    }
  }
  const states = Object.freeze([...stateSet]);

  // Terminal states: appear in the state set but have no outgoing transitions
  const terminalStates = Object.freeze(
    states.filter((s) => !transitions[s] || transitions[s].length === 0),
  );

  return { transitions, initial, states, terminalStates };
}

/**
 * Inline lifecycle — used as a schema field value.
 *
 * ```typescript
 * status: Lifecycle({ draft: ['published'], published: ['archived'] })
 * ```
 */
export function Lifecycle(transitions: Record<string, string[]>): LifecycleDescriptor {
  const frozen: TransitionMap = Object.freeze(
    Object.fromEntries(Object.entries(transitions).map(([k, v]) => [k, Object.freeze([...v])])),
  );
  return Object.freeze({ kind: 'lifecycle' as const, ...buildLifecycle(frozen) });
}

/**
 * Named lifecycle — reusable across entities.
 *
 * ```typescript
 * const PublishLifecycle = defineLifecycle('publish', { draft: ['published'], published: ['archived'] })
 * ```
 */
export function defineLifecycle(
  name: string,
  transitions: Record<string, string[]>,
): NamedLifecycle {
  const frozen: TransitionMap = Object.freeze(
    Object.fromEntries(Object.entries(transitions).map(([k, v]) => [k, Object.freeze([...v])])),
  );
  return Object.freeze({ kind: 'lifecycle' as const, name, ...buildLifecycle(frozen) });
}

// ── Type guard ───────────────────────────────────────────────────

export function isLifecycle(value: unknown): value is LifecycleDescriptor {
  return (
    typeof value === 'object' && value !== null && (value as { kind: unknown }).kind === 'lifecycle'
  );
}
