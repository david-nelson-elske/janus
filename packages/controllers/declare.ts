/**
 * Controller declaration — a pure-data, compile-time fact about a
 * controller: its name, values, targets, handlers, invokable actions,
 * channel needs, and operation dispatches.
 *
 * Declarations are imported by the registry, the manifest emitter, the
 * SSR attribute helpers, and (eventually) the agent capability graph.
 * They contain no runtime code, are safe to serialize, and are the
 * single source of truth the framework consults to validate everything
 * else.
 *
 * Per spec §5 of CONTROLLER-API-AND-ROUTER.md.
 */

// ── Value types ────────────────────────────────────────────────────
//
// The vocabulary of types a controller value may take. Mirrors what
// Stimulus's `static values` understands, plus an `?` suffix for
// optional (nullable) variants. Grows in lock-step with the projection
// type system in spec 3.

export type ValueTypeDecl =
  | 'string'
  | 'string?'
  | 'number'
  | 'number?'
  | 'boolean'
  | 'boolean?'
  | 'json';

// ── Invokable action declarations ─────────────────────────────────

/**
 * Set of actor surfaces that may invoke a controller action.
 *
 * - `agent-surface` — the LLM agent runtime via a `ui-command` publish.
 * - `controller`    — another mounted controller calling `invoke()`.
 * - `test`          — a test harness simulating an invocation.
 */
export type ActorSurface = 'agent-surface' | 'controller' | 'test';

export interface InvokableActionDecl {
  /**
   * Parameter shape for the invocation. Mirrors `ValueTypeDecl`.
   * Validated at the invocation boundary in dev mode.
   */
  readonly params: Readonly<Record<string, ValueTypeDecl>>;
  /** Which actor surfaces may invoke this action. */
  readonly allowedActors: readonly ActorSurface[];
}

// ── Controller declaration ─────────────────────────────────────────

export interface ControllerDeclaration {
  /** Stable identifier referenced in manifests, attributes, agent tool calls. */
  readonly name: string;

  /** Typed initial values flowed in from the projection via data-*-value attrs. */
  readonly values: Readonly<Record<string, ValueTypeDecl>>;

  /** Named DOM targets the controller may reach for. */
  readonly targets: readonly string[];

  /**
   * Method names wired via `data-action="event->name#method"`. Listed
   * here so the server can validate emitted action attrs against what
   * the controller actually exposes.
   */
  readonly handlers: readonly string[];

  /**
   * Actions callable by name from outside the DOM event system — by
   * the agent, by other controllers, by tests. The capability graph
   * (spec 5) compiles this into the agent's tool list.
   */
  readonly invokable: Readonly<Record<string, InvokableActionDecl>>;

  /** Channels this controller subscribes to. Channel layer is spec 2. */
  readonly subscribes: readonly string[];

  /** Channels this controller publishes on. */
  readonly publishes: readonly string[];

  /**
   * Operations this controller may dispatch on behalf of the user.
   * Authoritative authorization is still per-operation per-user; this
   * list is used for sanity-check validation only.
   */
  readonly dispatches: readonly string[];
}

// ── declareController ─────────────────────────────────────────────

/**
 * Declare a controller. Returns the same object (typed); the function
 * exists to enforce the shape at the call site and to give us a single
 * place to add validation later.
 *
 * Usage:
 *
 *   export const decisionDoc = declareController({
 *     name: 'decision-doc',
 *     values: { decisionId: 'string', activeSectionId: 'string?' },
 *     targets: ['section', 'cell', 'banner'],
 *     handlers: ['cellFocusOut', 'cellInput'],
 *     invokable: {
 *       highlightSection: {
 *         params: { sectionId: 'string' },
 *         allowedActors: ['agent-surface', 'controller'],
 *       },
 *     },
 *     subscribes: ['decision-updated'],
 *     publishes: ['interaction-event'],
 *     dispatches: ['item:update'],
 *   } as const);
 */
export function declareController<T extends ControllerDeclaration>(decl: T): T {
  validateDeclaration(decl);
  return decl;
}

// ── Validation ────────────────────────────────────────────────────

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const VALID_VALUE_TYPES: ReadonlySet<ValueTypeDecl> = new Set([
  'string',
  'string?',
  'number',
  'number?',
  'boolean',
  'boolean?',
  'json',
]);
const VALID_ACTORS: ReadonlySet<ActorSurface> = new Set([
  'agent-surface',
  'controller',
  'test',
]);

function validateDeclaration(decl: ControllerDeclaration): void {
  if (!NAME_PATTERN.test(decl.name)) {
    throw new Error(
      `[declareController] invalid name "${decl.name}" — must be kebab-case starting with a letter`,
    );
  }

  for (const [key, type] of Object.entries(decl.values)) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(
        `[declareController:${decl.name}] invalid value key "${key}" — must be camelCase`,
      );
    }
    if (!VALID_VALUE_TYPES.has(type)) {
      throw new Error(
        `[declareController:${decl.name}] invalid value type "${type}" for key "${key}"`,
      );
    }
  }

  for (const target of decl.targets) {
    if (!KEY_PATTERN.test(target)) {
      throw new Error(
        `[declareController:${decl.name}] invalid target "${target}" — must be camelCase`,
      );
    }
  }

  for (const handler of decl.handlers) {
    if (!KEY_PATTERN.test(handler)) {
      throw new Error(
        `[declareController:${decl.name}] invalid handler "${handler}" — must be camelCase`,
      );
    }
  }

  for (const [actionName, action] of Object.entries(decl.invokable)) {
    if (!KEY_PATTERN.test(actionName)) {
      throw new Error(
        `[declareController:${decl.name}] invalid invokable action "${actionName}" — must be camelCase`,
      );
    }
    for (const [paramName, paramType] of Object.entries(action.params)) {
      if (!KEY_PATTERN.test(paramName)) {
        throw new Error(
          `[declareController:${decl.name}.${actionName}] invalid param key "${paramName}"`,
        );
      }
      if (!VALID_VALUE_TYPES.has(paramType)) {
        throw new Error(
          `[declareController:${decl.name}.${actionName}] invalid param type "${paramType}" for "${paramName}"`,
        );
      }
    }
    for (const actor of action.allowedActors) {
      if (!VALID_ACTORS.has(actor)) {
        throw new Error(
          `[declareController:${decl.name}.${actionName}] invalid actor "${actor}"`,
        );
      }
    }
  }
}
