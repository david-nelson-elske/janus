/**
 * Agent surface declaration — the M4 capability-bearing identity an
 * LLM agent operates under.
 *
 * Per `.planning/AGENT-INTROSPECTION.md` §5. Distinct from the
 * `agentSurface()` helper in `./surface.ts`, which produces the
 * *pipeline initiator* (dispatch wiring); `declareAgentSurface()`
 * produces the *capability declaration* (reads, subscribes, invokes,
 * audit policy). Both coexist — different layers.
 *
 * The declaration is pure data, safe to read at compile time and
 * embed in boot-validation walks. v3 (M4) keeps reads / subscribes
 * / invokes as hand-listed strings; M5's capability graph derives
 * them from `(actor, action, scope)` triples and replaces the
 * keys here with capability handles.
 */

import type { ChannelDeclaration } from '@janus/channels';
import type { ProjectionDeclaration } from '@janus/projections';

// ── Subscription scope binding ────────────────────────────────────

/**
 * One entry in a surface's `subscribes` list. Channel name + a
 * scope template. Scope values are either literals or `ctx.<field>`
 * references resolved by the subscription bridge at registration
 * time.
 *
 * Example:
 * ```ts
 * { channel: 'decision-updated', scope: { decisionId: 'ctx.decisionId' } }
 * ```
 *
 * The bridge captures the resolved scope from each publish and
 * passes it to the wake handler. v3 leaves the resolver inline
 * with the channel runtime; M5's capability graph formalizes the
 * reference grammar.
 */
export interface SurfaceSubscription {
  readonly channel: string;
  readonly scope: Readonly<Record<string, string>>;
}

/**
 * One entry in a surface's `invokes` list — a `(controller, action)`
 * pair. The boot validator cross-references each against the
 * declared `invokable` map on the named controller and rejects if
 * either the action doesn't exist or `agent-surface` (or this
 * surface's role) isn't in its `allowedActors`.
 */
export interface SurfaceInvocation {
  readonly controller: string;
  readonly action: string;
}

// ── Surface runtime ──────────────────────────────────────────────

export type SurfaceRuntime =
  /** Wakes inside a single user-initiated request cycle (chat turn, voice turn). */
  | 'chat-bound'
  /**
   * Registered against the channel bridge — woken on every matching
   * publish. Long-running classifier / coherence-watcher pattern.
   * v3 wires the bridge but no-ops the wake handler; M5's runtime
   * fills in the LLM call.
   */
  | 'subscription';

export type SurfaceAudit =
  /** Persist an interaction_event for every wake — chat turn or publish. */
  | 'all'
  /** Persist only when the surface actually invoked something. */
  | 'on-action';

// ── Declaration ──────────────────────────────────────────────────

export interface AgentSurfaceDeclaration {
  /** Stable identifier. Referenced in tools, audit rows, manifest derivations. */
  readonly name: string;

  /**
   * The role string `compose(..., { actorRole })` applies when the
   * surface reads a projection. Multiple surfaces may share a role;
   * the role's redactions apply to every surface that carries it.
   */
  readonly role: string;

  readonly runtime: SurfaceRuntime;

  /** Projections this surface may compose. Each name must resolve in the projection registry. */
  readonly reads: readonly string[];

  /** Channels this surface may subscribe to, with scope templates. */
  readonly subscribes: readonly SurfaceSubscription[];

  /** Controller actions this surface may invoke via `invoke_controller_action`. */
  readonly invokes: readonly SurfaceInvocation[];

  readonly audit: SurfaceAudit;

  /** Free-form description; surfaced in dev tooling + future surface directories. */
  readonly description?: string;
}

/**
 * Declaration constructor. v3 returns the input as-is (pure data);
 * later versions may attach derived metadata. The wrapper exists so
 * call sites get a typed identity and the boot validator has a
 * stable place to hang dev-mode shape checks.
 */
export function declareAgentSurface<D extends AgentSurfaceDeclaration>(decl: D): D {
  return decl;
}

// ── Registry typing ──────────────────────────────────────────────

/**
 * Shape an app's surface registry must satisfy. Used with the
 * `satisfies` operator at the registry call site:
 *
 * ```ts
 * export const AGENT_SURFACE_REGISTRY = {
 *   'chat-agent': chatAgent,
 * } as const satisfies AgentSurfaceRegistry;
 * ```
 */
export type AgentSurfaceRegistry = Readonly<Record<string, AgentSurfaceDeclaration>>;

// ── Boot-time validation ─────────────────────────────────────────

/**
 * What the validator needs from the host app to check cross-
 * references. Each field is a registry the host already maintains.
 */
export interface ValidationRegistries {
  /** Projection registry. Each `reads` entry must exist as a key. */
  readonly projections: Readonly<Record<string, ProjectionDeclaration>>;
  /** Channel registry. Each `subscribes` entry's channel must exist. */
  readonly channels: Readonly<Record<string, ChannelDeclaration>>;
  /**
   * Controller registry. Each `invokes` entry's controller must
   * exist, and the named action must appear in its `invokable` map
   * with `agent-surface` (or the surface's role) in `allowedActors`.
   * The type is loose because controllers vary in shape; the
   * validator narrows at runtime via property checks.
   */
  readonly controllers: Readonly<Record<string, ControllerLike>>;
}

interface ControllerLike {
  readonly name?: string;
  readonly invokable?: Readonly<Record<string, InvokableLike>>;
}

interface InvokableLike {
  readonly allowedActors?: readonly string[];
}

/**
 * Walk every declared surface and verify its `reads` / `subscribes` /
 * `invokes` cross-references. Throws a useful error on the first
 * mismatch — boot should fail fast.
 *
 * Called once during app boot, after all registries are populated.
 */
export function validateAgentSurfaces(
  surfaces: AgentSurfaceRegistry,
  registries: ValidationRegistries,
): void {
  const errors: string[] = [];

  for (const [surfaceName, surface] of Object.entries(surfaces)) {
    if (surface.name !== surfaceName) {
      errors.push(
        `agent-surface "${surfaceName}": registry key does not match declaration name "${surface.name}"`,
      );
    }

    for (const projName of surface.reads) {
      if (!registries.projections[projName]) {
        errors.push(
          `agent-surface "${surfaceName}": reads unknown projection "${projName}"`,
        );
      }
    }

    for (const sub of surface.subscribes) {
      if (!registries.channels[sub.channel]) {
        errors.push(
          `agent-surface "${surfaceName}": subscribes to unknown channel "${sub.channel}"`,
        );
      }
    }

    for (const inv of surface.invokes) {
      const ctrl = registries.controllers[inv.controller];
      if (!ctrl) {
        errors.push(
          `agent-surface "${surfaceName}": invokes on unknown controller "${inv.controller}"`,
        );
        continue;
      }
      const action = ctrl.invokable?.[inv.action];
      if (!action) {
        errors.push(
          `agent-surface "${surfaceName}": controller "${inv.controller}" has no invokable action "${inv.action}"`,
        );
        continue;
      }
      const allowed = action.allowedActors ?? [];
      const allowedSet = new Set(allowed);
      if (!allowedSet.has('agent-surface') && !allowedSet.has(surface.role)) {
        errors.push(
          `agent-surface "${surfaceName}": action "${inv.controller}.${inv.action}" doesn't list "agent-surface" or "${surface.role}" in allowedActors (has [${allowed.join(', ')}])`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[agent-surfaces] validation failed:\n  - ${errors.join('\n  - ')}`,
    );
  }
}
