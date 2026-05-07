/**
 * Core types for the ADR-124 Participation Model.
 *
 * Vocabulary types (Str, Int, Lifecycle, Relation, etc.) import from @janus/vocabulary.
 * This file defines the participation-model-specific types.
 */

import type {
  AuditLevel,
  ClassifiedSchema,
  LifecycleDescriptor,
  SemanticField,
  Sensitivity,
  StorageStrategy,
  WiringEffects,
  WiringType,
} from '@janus/vocabulary';

// ── Operations (4 string literals, replaces 9-kind union) ───────

export type Operation = 'read' | 'create' | 'update' | 'delete';

export const ALL_OPERATIONS: readonly Operation[] = Object.freeze([
  'read',
  'create',
  'update',
  'delete',
]);

export const WRITE_OPERATIONS: readonly Operation[] = Object.freeze([
  'create',
  'update',
  'delete',
]);

// ── Event Descriptors (re-exported from vocabulary) ─────────────

export type {
  EventDescriptor,
} from '@janus/vocabulary';

export {
  Created,
  Updated,
  Deleted,
  Acted,
  Transitioned,
  isMutationEvent,
} from '@janus/vocabulary';

import type { EventDescriptor } from '@janus/vocabulary';

export function isActedEvent(
  e: EventDescriptor,
): e is EventDescriptor & { kind: 'acted'; name: string } {
  return e.kind === 'acted';
}

// ── Origin (replaces RealmKind) ─────────────────────────────────

export type Origin = 'framework' | 'consumer';

// ── New participation-model types ───────────────────────────────

export type AgentInteractionLevel = 'read-write' | 'read' | 'aware';
export type ActionKind = 'query' | 'mutation' | 'effect';
export type FailurePolicy = 'log' | 'retry';

export interface RetryConfig {
  readonly max: number;           // max attempts (default: 3)
  readonly backoff: 'fixed' | 'exponential';
  readonly initialDelay: number;  // milliseconds (default: 1000)
}

// ── Schema field union ──────────────────────────────────────────

export type SchemaField = SemanticField | WiringType | LifecycleDescriptor;

// ── Index config (shared prerequisite for D3/D5) ──────────────

export interface IndexConfig {
  readonly fields: readonly string[];
  readonly unique?: boolean;
  readonly name?: string;
}

// ── Schema evolution config (ADR 04c) ──────────────────────────

export interface EvolveConfig {
  /** Renamed fields: old name → new name. */
  readonly renames?: Readonly<Record<string, string>>;
  /** Default values for new required columns or NULL backfill. */
  readonly backfills?: Readonly<Record<string, unknown>>;
  /** Acknowledged drops: field names that were intentionally removed. */
  readonly drops?: readonly string[];
  /** Type coercions: field name → transform function. */
  readonly coercions?: Readonly<Record<string, (old: unknown) => unknown>>;
  /** Lifecycle state mapping: field name → { removed state → replacement state }. */
  readonly stateMap?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

// ── Entity definition types ─────────────────────────────────────

export interface LifecycleEntry {
  readonly field: string;
  readonly lifecycle: LifecycleDescriptor;
}

export interface WiringFieldEntry {
  readonly field: string;
  readonly wiring: WiringType;
}

export interface TransitionTarget {
  readonly field: string;
  readonly from: string;
  readonly to: string;
  readonly name: string;
}

/**
 * Per-entity scope configuration for the scope concern (ADR 01e — region/tier scoping).
 *
 * Three tiers:
 *  - 'system': entity is global. All authenticated users can read; only callers
 *    whose role is in `bypassRoles` (default ['sysadmin','system']) can write.
 *  - 'province': every row carries `field` (a relation/string). Users only see
 *    rows whose `field` value matches one of their `identity.assignments[].scope`.
 *  - 'mixed': like 'province' but rows with `field === null` are treated as
 *    system-tier — visible to all, writable only by bypass roles.
 */
export type ScopeConfig =
  | { readonly tier: 'system'; readonly bypassRoles?: readonly string[] }
  | { readonly tier: 'province'; readonly field: string; readonly bypassRoles?: readonly string[] }
  | { readonly tier: 'mixed'; readonly field: string; readonly bypassRoles?: readonly string[] };

/**
 * Caller-scope argument passed with every store op (balcony-solar Phase 1).
 *
 * Distinct from `ScopeConfig` above: `ScopeConfig` declares how an *entity*'s rows
 * are scoped (a framework-level, per-entity property). `StoreScope` declares how
 * the *caller* is acting — what country/region/campaign they are authorised to
 * touch on this particular dispatch. `scope-enforce` combines the two.
 *
 * Three admissible forms:
 *   - Full structured scope (typical admin session, per D-02)
 *   - Plural campaignIds (multi-campaign federal-peer reads, per D-04)
 *   - 'system' sentinel (allowlisted bootstrappers only, per D-05/D-06; the
 *     file-path allowlist is enforced by a CI grep check, not the runtime)
 */
export type StoreScope =
  | {
      readonly country: string;
      readonly region?: string | null;
      readonly locality?: string | null;
      readonly campaignId: string;
      readonly tier: 'federal' | 'regional' | 'municipal';
    }
  | {
      readonly country: string;
      readonly campaignIds: readonly string[];
      readonly tier: 'federal';
    }
  | 'system';

export interface GraphNodeRecord {
  readonly name: string;
  readonly origin: Origin;
  readonly schema: Readonly<Record<string, SchemaField>>;
  readonly classifiedSchema: ClassifiedSchema;
  readonly storage: StorageStrategy;
  readonly description?: string;
  readonly owned?: boolean;
  readonly scope?: ScopeConfig;
  readonly sensitivity: Sensitivity;
  readonly lifecycles: readonly LifecycleEntry[];
  readonly wiringFields: readonly WiringFieldEntry[];
  readonly operations: readonly Operation[];
  readonly transitionTargets: readonly TransitionTarget[];
  readonly indexes?: readonly IndexConfig[];
  readonly evolve?: EvolveConfig;
  /**
   * Natural-key field list surfaced from `DefineConfig` (balcony-solar Phase 1,
   * D-26). Consumers read this via `app.registry.entity(name).naturalKey` — the
   * seed upsert helper uses it to choose between create and update.
   */
  readonly naturalKey?: readonly string[];
  /**
   * Entity-declared write-tier allowlist surfaced from `DefineConfig`
   * (balcony-solar Phase 3, D-22 + D-23). When present, scope-enforce denies
   * non-system create/update/delete calls whose caller-scope tier is not in
   * this list. Consumers read this via `app.registry.entity(name).writeTiers`.
   */
  readonly writeTiers?: readonly ('federal' | 'regional' | 'municipal' | 'system')[];
  /**
   * Entity-declared field-level write guard surfaced from `DefineConfig`
   * (balcony-solar Phase 3, D-24 + D-25). Invoked inside scope-enforce on
   * non-system create/update calls. Guard throws auth-error naming the
   * denied field. Consumers read this via `app.registry.entity(name).writeFieldGuard`.
   */
  readonly writeFieldGuard?: (
    input: Record<string, unknown>,
    scope: StoreScope,
  ) => void;
}

export interface DefineConfig {
  readonly schema: Record<string, SchemaField> | ClassifiedSchema;
  readonly storage: StorageStrategy;
  readonly description?: string;
  /**
   * When true, records are scoped to their owner (createdBy).
   * Read operations filter by identity.id unless the caller has admin role.
   * UPDATE @ M4 (ADR 01b): Enforced by the validate concern + store read scoping.
   */
  readonly owned?: boolean;
  /**
   * Per-entity tier scoping (ADR 01e). Declares this entity as system-wide,
   * region-scoped (province), or mixed (per-row null = system, value = region).
   * Enforced by the scope concern when participate(scope: true) is set.
   */
  readonly scope?: ScopeConfig;
  /** Override origin. Defaults to 'consumer'. Framework entities set this to 'framework'. */
  readonly origin?: Origin;
  /** Composite indexes on the entity's table. */
  readonly indexes?: readonly IndexConfig[];
  /** Schema evolution hints for migration (ADR 04c). Ephemeral — remove after migration. */
  readonly evolve?: EvolveConfig;
  /**
   * Natural-key field list (balcony-solar Phase 1, D-26). When present, the seed
   * upsert helper (`src/seed/upsert.ts`) uses these fields to look up existing
   * rows before deciding between create and update. Propagated to the entity's
   * `GraphNodeRecord` so callers can read it via `app.registry.entity(name).naturalKey`.
   *
   * Example: `naturalKey: ['slug']` for reference entities,
   *          `naturalKey: ['claim', 'category']` for content entities with
   *          compound natural identity.
   */
  readonly naturalKey?: readonly string[];
  /**
   * When set, non-system create/update/delete calls require the caller's
   * scope tier to appear in writeTiers. Read operations are unaffected.
   *
   * Consumer: balcony-solar Phase 3 (D-22, D-23). Editorial + national-
   * messaging entities declare `writeTiers: ['federal','system']` so only
   * federal-tier scopes and the 'system' sentinel can write; regional /
   * municipal callers are denied. Unset preserves pre-Phase-3 behaviour.
   */
  readonly writeTiers?: readonly ('federal' | 'regional' | 'municipal' | 'system')[];
  /**
   * Field-level write guard. Invoked inside scope-enforce on create/update
   * when the scope tier is not in the entity's privileged set. The guard
   * MUST throw an auth-error (shape: Object.assign(new Error(...), { kind: 'auth-error', retryable: false }))
   * naming the specific denied field. Signature is narrow by design — only
   * one entity (provincial_campaign) opts in this phase. If future entities
   * need field-level denial, promote to a first-class `deniedFieldsForTier`
   * declaration rather than adding a second lambda.
   */
  readonly writeFieldGuard?: (
    input: Record<string, unknown>,
    scope: StoreScope,
  ) => void;
}

export interface DefineResult {
  readonly kind: 'define';
  readonly record: GraphNodeRecord;
}

// ── Entity resolution helpers ──────────────────────────────────

/** Extract entity name from a string or DefineResult. Shared by participate() and subscribe(). */
export function resolveEntityName(entity: string | DefineResult): string {
  if (typeof entity === 'string') return entity;
  return entity.record.name;
}

// ── Entity name validation ──────────────────────────────────────

export const ENTITY_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
export const FIELD_NAME = /^_?[a-zA-Z][a-zA-Z0-9_]*$/;
export const MAX_ENTITY_NAME_LENGTH = 64;

// ── Asset backend (interface only — implementation in pipeline) ──

export interface AssetMeta {
  readonly filename: string;
  readonly contentType: string;
}

export interface AssetWriteResult {
  readonly path: string;
  readonly size: number;
  readonly checksum: string;
}

export interface AssetBackend {
  /** Write binary data to storage. Returns path, size, and checksum. */
  write(data: Uint8Array | ReadableStream<Uint8Array>, meta: AssetMeta): Promise<AssetWriteResult>;
  /** Resolve a storage path to a public URL. */
  url(path: string): string;
  /** Delete a file from storage. */
  delete(path: string): Promise<void>;
  /** Read file bytes from storage (for serving). */
  read(path: string): Promise<Uint8Array>;
}

// ── Handler() semantic type ─────────────────────────────────────

/**
 * Handler() — backend-resolved column type for function references.
 *
 * Stores a key string in the database, resolves to a function from the
 * runtime registry. Same pattern as Asset(), Append(), Template(), Channel().
 */
export interface HandlerColumn {
  readonly kind: 'handler';
}

export function Handler(): HandlerColumn {
  return Object.freeze({ kind: 'handler' as const });
}

// ── Handler types ───────────────────────────────────────────────

export type ExecutionHandler = (ctx: ConcernContext) => Promise<void>;

export interface HandlerEntry {
  readonly fn: ExecutionHandler;
  readonly description: string;
}

// ── Participation types ─────────────────────────────────────────

export interface ParticipationRecord {
  readonly source: string;
  readonly handler: string;
  readonly order: number;
  readonly transactional: boolean;
  readonly config: Readonly<Record<string, unknown>>;
  readonly operations?: readonly Operation[];
}

export interface ActionConfig {
  readonly handler: ExecutionHandler;
  readonly kind: ActionKind;
  readonly scoped?: boolean;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface PolicyConfig {
  readonly rules: readonly PolicyRule[];
  readonly anonymousRead?: boolean;
}

export interface PolicyRule {
  readonly role: string;
  readonly operations: '*' | readonly Operation[];
  readonly ownershipField?: string;
}

export interface RateLimitConfig {
  readonly max: number;
  readonly window: number;
}

export interface ObserveConfig {
  readonly on: readonly EventDescriptor[];
}

export interface InvariantConfig {
  readonly name: string;
  readonly predicate: (record: Record<string, unknown>) => boolean;
  readonly severity: 'error' | 'warning';
  readonly message?: string;
}

/**
 * Expanded audit config — allows overriding which operations are audited.
 * Short form: `audit: AuditFull` (writes only, default).
 * Expanded form: `audit: { level: AuditFull, operations: '*' }` (all operations).
 */
export interface AuditConfig {
  readonly level: AuditLevel;
  readonly operations?: '*' | readonly Operation[];
}

export interface ParticipateConfig {
  readonly policy?: PolicyConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly audit?: AuditLevel | AuditConfig;
  readonly observe?: ObserveConfig;
  readonly invariant?: readonly InvariantConfig[];
  readonly actions?: Record<string, ActionConfig>;
  /**
   * Enable the scope-enforce concern for this entity. The entity must declare
   * `scope` in its `define()` config; if absent, this is a no-op.
   */
  readonly scope?: boolean;
  readonly parse?: false;
  readonly validate?: false;
  readonly emit?: false;
  readonly respond?: false;
}

export interface ParticipateResult {
  readonly kind: 'participate';
  readonly records: readonly ParticipationRecord[];
}

// ── Capability types ────────────────────────────────────────────

/**
 * Capability primitive — peer to define()/participate() for operations that
 * are not entity-shaped: typed input → handler → typed output. Capabilities
 * carry their own input schema, opt-in audit, and identity propagation,
 * without requiring a synthetic entity to host them.
 */

export const CAPABILITY_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*__[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
export const MAX_CAPABILITY_NAME_LENGTH = 64;

export interface CapabilityContext {
  readonly identity: Identity;
  /** Internal dispatch for nested entity-graph calls. May be undefined in tests. */
  readonly dispatch?: InternalDispatch;
  /** Cooperative cancellation. Best-effort; agent loop currently does not enforce timeouts. */
  readonly signal?: AbortSignal;
  /** Correlation id propagated from caller for log/audit chaining. */
  readonly correlationId: string;
}

export type CapabilityHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  ctx: CapabilityContext,
) => Promise<TOutput>;

export interface CapabilityConfig<TInput = unknown, TOutput = unknown> {
  /** Tool name. Must match `namespace__verb`. */
  readonly name: string;
  /** One-line description for the tool catalog. */
  readonly description: string;
  /** Optional longer description for system-prompt context. */
  readonly longDescription?: string;
  /** Input field schema using Janus semantic types (Str, Int, Enum, etc.). */
  readonly inputSchema: Readonly<Record<string, SchemaField>>;
  /** Optional output schema. Used by MCP for structured returns; ignored by Anthropic tool API. */
  readonly outputSchema?: Readonly<Record<string, SchemaField>>;
  /** The handler. Receives validated input + a CapabilityContext. */
  readonly handler: CapabilityHandler<TInput, TOutput>;
  /** Cross-cutting concerns. All optional; reuse the same shapes as participate(). */
  readonly policy?: PolicyConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly audit?: AuditLevel | AuditConfig;
  /**
   * If true, fire onToolCall/onToolResult hooks but do not write a capability_call
   * row. Cheaper than `audit` for high-cardinality tool calls.
   */
  readonly observe?: boolean;
  /** Tags for grouping in the agent's system prompt and for filter allowlists. */
  readonly tags?: readonly string[];
}

export interface CapabilityRecord {
  readonly name: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly inputSchema: Readonly<Record<string, SchemaField>>;
  readonly outputSchema?: Readonly<Record<string, SchemaField>>;
  readonly handler: CapabilityHandler;
  readonly policy?: PolicyConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly audit?: AuditLevel | AuditConfig;
  readonly observe?: boolean;
  readonly tags?: readonly string[];
}

export interface CapabilityResult {
  readonly kind: 'capability';
  readonly record: CapabilityRecord;
}

// ── Subscription types (M7) ─────────────────────────────────────

export interface EventTrigger {
  readonly kind: 'event';
  readonly on: EventDescriptor;
}

export interface CronTrigger {
  readonly kind: 'cron';
  readonly expr: string;
}

export type SubscriptionTrigger = EventTrigger | CronTrigger;

export interface SubscriptionRecord {
  readonly source: string;
  readonly trigger: SubscriptionTrigger;
  readonly handler: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly failure: FailurePolicy;
  readonly tracked?: boolean;
  readonly retry?: RetryConfig;
}

export type SubscriptionInput = EventSubscriptionInput | CronSubscriptionInput;

export interface EventSubscriptionInput {
  readonly on: EventDescriptor;
  readonly handler: string;
  readonly config: Record<string, unknown>;
  readonly failure?: FailurePolicy;
  readonly tracked?: boolean;
  readonly retry?: RetryConfig;
}

export interface CronSubscriptionInput {
  readonly cron: string;
  readonly handler: string;
  readonly config: Record<string, unknown>;
  readonly failure?: FailurePolicy;
  readonly tracked?: boolean;
  readonly retry?: RetryConfig;
}

export interface SubscribeResult {
  readonly kind: 'subscribe';
  readonly records: readonly SubscriptionRecord[];
}

// ── Binding types (M8-core) ─────────────────────────────────────

export type ComponentType = (...args: unknown[]) => unknown;

export interface FieldBindingConfig {
  readonly component?: string;              // rendering hint: 'heading', 'richtext', 'badge', etc.
  readonly agent: AgentInteractionLevel;    // 'read-write' | 'read' | 'aware'
  readonly label?: string;
  readonly visible?: boolean;               // default: true
}

export interface BindingConfig {
  readonly fields?: Record<string, FieldBindingConfig>;
  readonly columns?: readonly string[];     // for list views: visible columns in order
  readonly layout?: string;                 // layout hint: 'single-column', 'two-column', 'tabbed'
  /** Override the entity-derived page title for this view.
   *
   *  List views otherwise default to the plural entity name (e.g. the
   *  `milestone` entity's list shows "milestones"). Detail views default
   *  to the record's `title` / `name` / id. Set `title` in the binding
   *  config to use a human-friendlier label without shadowing the
   *  binding with a custom route — e.g. set `"Timeline"` on a
   *  milestone list binding so the page title reads "Timeline — Site"
   *  instead of "milestones — Site".
   *
   *  Composed against `theme.title` via the same `${x} — ${theme.title}`
   *  format — only the left-hand side changes. */
  readonly title?: string;
  /** Async loader that composes the data passed to the bound component
   *  (ADR-124-12d). When present, the framework skips its default
   *  single-entity read and awaits the loader instead; the loader's
   *  return value reaches the component as the `data` prop.
   *
   *  Use when a page needs to compose multiple reads (e.g. a decision
   *  view that wants its decision + sections + steps + chat history on
   *  one page). Without a loader, the handler still performs the default
   *  filtered read (list) or read-by-id (detail) as it did pre-12d. */
  readonly loader?: Loader;
  /** Authorization check that runs before the loader / default read
   *  (ADR-124-12f). Receives the same `LoaderContext` the loader does,
   *  so it can consult the dispatch pipeline (e.g. resolve a member
   *  record to verify a tier). Returns:
   *    - `true` to proceed,
   *    - `false` to render a 403 error page,
   *    - `{ redirect }` to 302 to the given URL.
   *
   *  Identity policy for the common "require signed-in" and "require
   *  active tier" patterns lives on the binding, not in hand-wired
   *  middleware — so the rule travels with the view. */
  readonly require?: BindingRequire;
  /** How the binding component sits inside the rendered document
   *  (ADR-124-12e).
   *
   *  - `'shell'` (default): the component output is wrapped in the app
   *    shell (framework `DefaultShell` or consumer `layout.shell`). The
   *    component receives `contexts` / `fields` / `config` / `data` and
   *    renders only the center content.
   *  - `'full-page'`: the framework skips the shell wrap. The component
   *    renders directly into `<body>` and owns its own chrome (nav,
   *    rails, footer). `path`, `identity`, and `registry` are passed as
   *    props so the component can build its own nav. Use when a page
   *    needs a layout the app-level shell can't express — three-pane
   *    dashboards, conversation layouts, etc.
   *
   *  The document template (head, fonts, theme CSS, `__JANUS__`
   *  hydration) still wraps every page regardless of `renderMode`. */
  readonly renderMode?: BindingRenderMode;
}

/** How a binding component renders inside the document (ADR-124-12e).
 *  `'shell'` (default) wraps the component in the app shell.
 *  `'full-page'` gives the component the whole viewport. */
export type BindingRenderMode = 'shell' | 'full-page';

// ── Binding loader types (ADR-124-12d) ──────────────────────────

/** Context object passed to a binding loader. The `read` and `dispatch`
 *  helpers thread the request's resolved identity into every call, so
 *  loader data access goes through the same policy/audit/observe pipeline
 *  as any other dispatch — a loader cannot bypass authorization. */
export interface LoaderContext {
  /** Route params extracted from the URL. Detail views populate `id`;
   *  list views receive an empty object. */
  readonly params: { readonly id?: string };
  /** Identity resolved from the session cookie, or `ANONYMOUS`. */
  readonly identity: Identity;
  /** The parsed request URL. Useful for reading query params beyond the
   *  framework's built-in list-view params. */
  readonly url: URL;
  /** The raw Fetch Request. Available when a loader needs headers or
   *  the request body beyond what `url` exposes. */
  readonly request: Request;
  /** Shortcut for a `read` dispatch against the runtime. Identity is
   *  threaded automatically; the policy concern runs as usual. Returns
   *  the response's `data` payload directly and throws on a dispatch
   *  error, to keep loader code concise. */
  read(entity: string, input?: unknown): Promise<unknown>;
  /** General-purpose dispatch helper. Returns the full `DispatchResponse`
   *  so the loader can inspect `ok`, `error`, warnings, etc. */
  dispatch(entity: string, operation: string, input?: unknown): Promise<DispatchResponse>;
}

/** A binding loader. Runs before the component renders; its return value
 *  reaches the component as the `data` prop. */
export type Loader<TData = unknown> = (ctx: LoaderContext) => Promise<TData>;

// ── Binding route policy (ADR-124-12f) ──────────────────────────

/** Result of a binding `require` check.
 *  - `true` → authorization passes, request proceeds to loader/component.
 *  - `false` → deny with a 403 error page.
 *  - `{ redirect }` → deny and redirect to the given URL (commonly
 *    `/login` for unauthenticated or `/activate` for inactive tiers). */
export type BindingRequireResult =
  | true
  | false
  | { readonly redirect: string };

/** A binding authorization check. Runs after identity resolution and
 *  before the loader (or default read) fires. Receives the same context
 *  as a loader so it can consult the dispatch pipeline when needed
 *  (e.g. resolving a member record to check a tier). Async is allowed. */
export type BindingRequire = (
  ctx: LoaderContext,
) => BindingRequireResult | Promise<BindingRequireResult>;

export interface BindingRecord {
  readonly source: string;
  readonly component: ComponentType;
  readonly view: string;
  readonly config: BindingConfig;
}

export interface BindingInput {
  readonly component: ComponentType;
  readonly view: string;
  readonly config: BindingConfig;
}

export interface BindResult {
  readonly kind: 'bind';
  readonly records: readonly BindingRecord[];
}

export interface BindingIndex {
  byEntity(entity: string): readonly BindingRecord[];
  byView(view: string): readonly BindingRecord[];
  byEntityAndView(entity: string, view: string): BindingRecord | undefined;
}

// ── Drop declaration (ADR 04c schema reconciliation) ────────────

export interface DropResult {
  readonly kind: 'drop';
  readonly entity: string;
}

// ── Declaration record (input to compile) ───────────────────────

export type DeclarationRecord =
  | DefineResult
  | ParticipateResult
  | CapabilityResult
  | SubscribeResult
  | BindResult
  | DropResult;

// ── Identity ────────────────────────────────────────────────────

/**
 * A scope assignment grants the identity access to records whose scope field
 * matches the assignment's scope value (typically a region id or slug).
 *
 * The optional `role` is informational — the scope concern uses only `scope`
 * to filter records. Per-operation gating is policy-lookup's job (role-based).
 *
 * Apps that don't use scoped entities can ignore this entirely.
 */
export interface ScopeAssignment {
  /** The scope value the identity has access to (e.g. a region id or slug). */
  readonly scope: string;
  /** Optional: the role granted within this scope. Apps can use this to drive policy. */
  readonly role?: string;
  /**
   * Campaign id this assignment grants access to (balcony-solar Phase 1, FND-03a).
   * Post-Phase-1 `sessionToIdentity` emits this alongside `scope` so the new
   * `StoreScope`-based authorisation can resolve the caller's allowed campaigns
   * without inferring them from region slugs. Optional to preserve compatibility
   * with existing consumers whose assignments carry a region slug only.
   */
  readonly campaignId?: string;
  /** Country the assignment is bounded by (balcony-solar Phase 1). Optional; used by hierarchy walk. */
  readonly country?: string;
  /** Region the assignment is bounded by (balcony-solar Phase 1). Null for federal assignments. */
  readonly region?: string | null;
  /** Locality the assignment is bounded by (balcony-solar Phase 1). Null for federal/regional assignments. */
  readonly locality?: string | null;
}

export interface Identity {
  readonly id: string;
  readonly roles: readonly string[];
  readonly scopes?: readonly string[];
  /**
   * Per-scope grants used by the scope concern to filter scoped entities.
   * Each assignment names a scope value (region) the identity can read/write.
   * Empty or missing means no scoped access (sysadmin role bypasses this).
   */
  readonly assignments?: readonly ScopeAssignment[];
}

export const ANONYMOUS: Identity = Object.freeze({
  id: 'anonymous',
  roles: Object.freeze(['anonymous']),
});

export const SYSTEM: Identity = Object.freeze({
  id: 'system',
  roles: Object.freeze(['system']),
});

// ── Pipeline types ──────────────────────────────────────────────

export type PipelineStage = (ctx: ConcernContext) => Promise<void>;

export interface FrozenPipeline {
  readonly preTx: readonly PipelineStage[];
  readonly tx: readonly PipelineStage[];
  readonly postTx: readonly PipelineStage[];
  readonly needsTx: boolean;
}

// ── Persist routing ─────────────────────────────────────────────

export type AdapterKind = 'relational' | 'memory' | 'derived' | 'virtual' | 'file';

export interface RoutingRecord {
  readonly entity: string;
  readonly table: string;
  readonly adapter: AdapterKind;
  readonly schema: Readonly<Record<string, SchemaField>>;
  readonly storage: StorageStrategy;
  readonly indexes?: readonly IndexConfig[];
  readonly evolve?: EvolveConfig;
}

// ── Store types (canonical definitions for dispatch contract) ─────

export interface EntityRecord {
  readonly id: string;
  readonly _version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly _deletedAt?: string;
  readonly [field: string]: unknown;
}

export interface NewEntityRecord {
  id?: string;
  [field: string]: unknown;
}

export interface ReadPage {
  readonly records: readonly EntityRecord[];
  readonly total?: number;
  readonly hasMore: boolean;
  readonly offset?: number;
  readonly limit?: number;
}

/** Type guard: distinguish ReadPage (browse result) from EntityRecord (single record). */
export function isReadPage(result: EntityRecord | ReadPage): result is ReadPage {
  return 'records' in result && 'hasMore' in result;
}

export interface ReadParams {
  readonly id?: string;
  readonly where?: Record<string, unknown>;
  readonly sort?: readonly SortClause[];
  readonly limit?: number;
  readonly offset?: number;
  readonly includeDeleted?: boolean;
  readonly search?: string;
  /**
   * Caller-scope argument (balcony-solar Phase 1, D-01..D-06). Optional at the
   * type level per D-08 (type-level enforcement deferred); `scope-enforce`
   * throws `auth-error` at runtime when absent on non-allowlisted call sites.
   */
  readonly scope?: StoreScope;
  /**
   * Active language for translatable-field resolution (ADR 125-00). When set,
   * adapters configured with translatable support rewrite returned records
   * so `record.<field>` reflects the active-lang column with default-lang
   * fallback; where-clause references to translatable fields are rewritten
   * to query the matching `<field>_<lang>` column. Untranslatable adapters
   * ignore this field.
   */
  readonly lang?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface SortClause {
  readonly field: string;
  readonly direction: SortDirection;
}

export interface UpdateOptions {
  readonly expectedVersion?: number;
  /**
   * Active language for translatable-field writes (ADR 125-00). When set,
   * adapters route bare translatable field values to the matching
   * `<field>_<lang>` column instead of the default-lang column. Callers
   * may also write to specific lang columns directly (e.g. `{ title_fr: 'X' }`).
   */
  readonly lang?: string;
}

export interface EntityStore {
  read(entity: string, params?: ReadParams): Promise<EntityRecord | ReadPage>;
  create(entity: string, record: NewEntityRecord): Promise<EntityRecord>;
  update(entity: string, id: string, patch: Record<string, unknown>, options?: UpdateOptions): Promise<EntityRecord>;
  delete(entity: string, id: string): Promise<void>;
  withTransaction<T>(fn: (tx: EntityStore) => Promise<T>): Promise<T>;
  initialize(): Promise<void>;
  /** Count records matching a where clause (ADR 01d — restrict checks). */
  count(entity: string, where: Record<string, unknown>): Promise<number>;
  /** Update all records matching a where clause. Returns count of updated rows (ADR 01d — nullify). */
  updateWhere(entity: string, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<number>;
}

// ── Persist result ──────────────────────────────────────────────

export type PersistResult =
  | { readonly kind: 'record'; readonly record: EntityRecord }
  | { readonly kind: 'page'; readonly page: ReadPage }
  | { readonly kind: 'void' }
  | { readonly kind: 'output'; readonly data: unknown };

/** Extract the data payload from a PersistResult (record, page, output data, or undefined). */
export function extractResultData(result: PersistResult | undefined): unknown {
  if (!result) return undefined;
  switch (result.kind) {
    case 'record': return result.record;
    case 'page': return result.page;
    case 'output': return result.data;
    default: return undefined;
  }
}

// ── Dispatch types ──────────────────────────────────────────────

export interface DispatchError {
  readonly kind: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

export interface DispatchWarning {
  readonly stage: string;
  readonly message: string;
}

export interface DispatchResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly meta: {
    readonly correlationId: string;
    readonly entity: string;
    readonly operation: string;
    readonly durationMs: number;
    readonly depth: number;
  };
  readonly error?: DispatchError;
  readonly warnings?: readonly DispatchWarning[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type InternalDispatch = (
  entity: string,
  operation: string,
  input: unknown,
  identity: Identity,
) => Promise<DispatchResponse>;

// ── HTTP request context ───────────────────────────────────────

export interface HttpRequestContext {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
}

// ── Agent request context ─────────────────────────────────────

export interface AgentRequestContext {
  readonly agentId: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly toolCall?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

// ── ConcernContext ──────────────────────────────────────────────

export interface ConcernContext {
  // Immutable (set by dispatch runtime)
  readonly correlationId: string;
  readonly traceId: string;
  readonly identity: Identity;
  readonly entity: string;
  readonly operation: Operation;
  readonly input: unknown;
  readonly startedAt: number;
  readonly depth: number;
  readonly config: Readonly<Record<string, unknown>>;

  // Infrastructure (injected by dispatch runtime)
  readonly store: EntityStore;
  readonly registry: CompileResult;
  readonly _dispatch?: InternalDispatch;
  readonly broker?: { notify(notification: { entity: string; entityId?: string; descriptor: string; correlationId: string }): void };

  // Asset backend (injected by dispatch runtime when configured)
  readonly assetBackend?: AssetBackend;

  // Transport metadata (set by dispatch runtime from context param)
  readonly httpRequest?: HttpRequestContext;
  readonly agentRequest?: AgentRequestContext;

  // Mutable (accumulated by concern stages)
  parsed?: Record<string, unknown>;
  validated?: boolean;
  before?: EntityRecord | null;
  result?: PersistResult;
  error?: DispatchError;
  outboundErrors?: Array<{ stage: string; error: unknown }>;

  // Set by policy-lookup, read by schema-validate for ownership enforcement
  // UPDATE @ M4+: Enforce ownership scoping in validate + store read filtering
  policyOwnershipField?: string;

  // Transport extensions — concern handlers write here, copied to DispatchResponse.extensions
  extensions?: Record<string, unknown>;
}

// ── Mutable context field list ──────────────────────────────────

/**
 * Mutable accumulator fields on ConcernContext.
 * Used for copy-back between prototype-inherited contexts (stage → parent, tx → outer).
 */
export const MUTABLE_CTX_FIELDS = Object.freeze([
  'parsed', 'validated', 'before', 'result', 'error', 'outboundErrors', 'policyOwnershipField', 'extensions', 'identity',
] as const);

/** Set identity on a concern context (bypasses readonly for transport handlers). */
export function setIdentity(ctx: ConcernContext, identity: Identity): void {
  (ctx as unknown as Record<string, unknown>).identity = identity;
}

/** Copy own mutable fields from a prototype-inherited context back to its parent. */
export function copyOwnCtxFields(from: ConcernContext, to: ConcernContext): void {
  for (const field of MUTABLE_CTX_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(from, field)) {
      (to as unknown as Record<string, unknown>)[field] = (from as unknown as Record<string, unknown>)[field];
    }
  }
}

/**
 * Create a scoped handler context with config injected via prototypal inheritance.
 * Used by pipeline stage closures (compile.ts), subscription processor, and anywhere
 * a handler needs to run with its own config against a shared base context.
 *
 * Returns the scoped context and a copyBack function to propagate mutable fields.
 */
export function createHandlerContext(
  base: ConcernContext,
  config: Readonly<Record<string, unknown>>,
): { ctx: ConcernContext; copyBack: () => void } {
  const scoped = Object.create(base) as ConcernContext;
  (scoped as unknown as Record<string, unknown>).config = config;
  return {
    ctx: scoped,
    copyBack: () => copyOwnCtxFields(scoped, base),
  };
}

// ── Wiring index ────────────────────────────────────────────────

export interface WiringEdge {
  readonly from: string;
  readonly fromField: string;
  readonly to: string;
  readonly kind: 'relation' | 'reference' | 'mention';
  readonly effects?: WiringEffects;
}

export interface WiringIndex {
  readonly edges: readonly WiringEdge[];
  outbound(entity: string): readonly WiringEdge[];
  inbound(entity: string): readonly WiringEdge[];
  /** All inbound edges to an entity that have non-empty effects (ADR 01d). */
  reverseEffects(entity: string): readonly WiringEdge[];
}

// ── Query field (agent-discoverable field metadata) ─────────────

export interface QueryFieldRecord {
  readonly entity: string;
  readonly field: string;
  readonly type: string;
  readonly operators: readonly string[];
  readonly required: boolean;
  /** True when this field is wrapped in `Translatable(...)`. Type reflects the base. */
  readonly translatable?: boolean;
}

/** Operators available per semantic type kind */
export const OPERATORS_BY_TYPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  str: Object.freeze(['eq', 'ne', 'like', 'in', 'nin', 'null']),
  markdown: Object.freeze(['eq', 'ne', 'like', 'null']),
  email: Object.freeze(['eq', 'ne', 'like', 'in', 'null']),
  int: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'null']),
  float: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'null']),
  intCents: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'null']),
  intBps: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'null']),
  bool: Object.freeze(['eq', 'ne', 'null']),
  datetime: Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'null']),
  enum: Object.freeze(['eq', 'ne', 'in', 'nin', 'null']),
  lifecycle: Object.freeze(['eq', 'ne', 'in', 'nin']),
  relation: Object.freeze(['eq', 'ne', 'null']),
  reference: Object.freeze(['eq', 'ne', 'null']),
  json: Object.freeze(['null']),
  token: Object.freeze(['eq', 'ne', 'like', 'in', 'null']),
  qrcode: Object.freeze(['eq', 'ne', 'null']),
});

// ── Compile filter ──────────────────────────────────────────────

export interface CompileFilter {
  readonly entity?: string;
  readonly initiator?: string;
  readonly handler?: string;
}

// ── Compile result ──────────────────────────────────────────────

export interface CompileResult {
  // Core table indexes
  readonly graphNodes: ReadonlyMap<string, GraphNodeRecord>;
  readonly participations: readonly ParticipationRecord[];
  readonly subscriptions: readonly SubscriptionRecord[];
  readonly bindings: readonly BindingRecord[];
  readonly capabilities: ReadonlyMap<string, CapabilityRecord>;

  // Dispatch
  readonly dispatchIndex: ReadonlyMap<string, FrozenPipeline>;
  readonly initiators: ReadonlyMap<string, InitiatorConfig>;

  // Routing
  readonly persistRouting: readonly RoutingRecord[];

  // Schema reconciliation
  readonly drops: ReadonlySet<string>;

  // Wiring
  readonly wiring: WiringIndex;

  // Binding
  readonly bindingIndex: BindingIndex;

  // Metadata
  readonly compiledAt: string;
  readonly compilationDuration: number;

  // Query helpers
  pipeline(initiator: string, entity: string, operation: string): FrozenPipeline | undefined;
  entity(name: string): GraphNodeRecord | undefined;
  capability(name: string): CapabilityRecord | undefined;
  participationsFor(entity: string): readonly ParticipationRecord[];
  operationsFor(entity: string): readonly Operation[];
  queryFields(entity: string): readonly QueryFieldRecord[];
}

// ── Initiator config ────────────────────────────────────────────

export interface InitiatorConfig {
  readonly name: string;
  readonly origin: Origin;
  readonly participations?: readonly ParticipationRecord[];
}
