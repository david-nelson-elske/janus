/**
 * Projection type vocabulary — the shape of a projection declaration
 * and the selector tree it carries.
 *
 * Per `.planning/PROJECTION-DECLARATIONS.md` §5–§7 of Perspicuity.
 */

import type { SortClause } from '@janus/core';
import type { FieldFilter, PrimitiveValue } from '@janus/store';
import type { ChannelDeclaration } from '@janus/channels';

// ── References ─────────────────────────────────────────────────

/**
 * A value resolved at compose time against the request context. The
 * `from` string is a dotted path rooted at one of:
 *
 *   - `params.X` — opts.params[X]
 *   - `ctx.X`    — opts.ctx[X]
 *   - `parent.X` — the parent relation row currently being expanded
 *   - `root.X`   — the resolved root record
 */
export interface FromRef {
  readonly from: string;
}

/**
 * Shorthand for `{ from: 'parent.X' }`. Mirrors the spec's
 * `{ section: { ref: 'parent.id' } }` example.
 */
export interface ParentRef {
  readonly ref: string;
}

export type Reference = FromRef | ParentRef;

// ── Where clauses ──────────────────────────────────────────────

/**
 * A selector where-value: a reference, a store filter operator object,
 * an array of literals, or a literal. Mirrors the store's `WhereClause`
 * but widens it to accept reference values that resolve at compose
 * time.
 */
export type SelectorWhereValue =
  | Reference
  | FieldFilter
  | readonly PrimitiveValue[]
  | PrimitiveValue;

export type SelectorWhereClause = Readonly<Record<string, SelectorWhereValue>>;

// ── Root + relation specs ─────────────────────────────────────

export type RelationKind = 'hasMany' | 'belongsTo' | 'hasOne';

export interface AggregateCount {
  readonly kind: 'count';
  readonly relation: string;
}

export interface AggregateExists {
  readonly kind: 'exists';
  readonly relation: string;
}

export type AggregateSpec = AggregateCount | AggregateExists;

export interface RelationSpec {
  readonly kind: RelationKind;
  readonly from: string;
  readonly where?: SelectorWhereClause;
  readonly sort?: readonly SortClause[];
  readonly limit?: number;
  readonly fields: readonly string[];
  readonly relations?: Readonly<Record<string, RelationSpec>>;
  readonly aggregates?: Readonly<Record<string, AggregateSpec>>;
}

export type RootByIdSpec = {
  readonly entity: string;
  readonly byId: Reference;
};

export type RootWhereSpec = {
  readonly entity: string;
  readonly where: SelectorWhereClause;
};

export type RootListSpec = {
  readonly entity: string;
  readonly list: true;
  readonly where?: SelectorWhereClause;
  readonly sort?: readonly SortClause[];
  readonly limit?: number;
};

export type RootSpec = RootByIdSpec | RootWhereSpec | RootListSpec;

export interface SelectorTree {
  readonly root: RootSpec;
  readonly fields: readonly string[];
  readonly relations?: Readonly<Record<string, RelationSpec>>;
  readonly aggregates?: Readonly<Record<string, AggregateSpec>>;
  /**
   * Maximum nesting depth allowed in `relations`. Spec §13 — caps
   * runaway selectors at compile time. Defaults to 4 if absent.
   */
  readonly maxDepth?: number;
}

// ── Param + redaction types ──────────────────────────────────

export type ProjectionParamType = 'string' | 'number' | 'boolean';

export type ProjectionParams = Readonly<Record<string, ProjectionParamType>>;

/**
 * Per-role redaction sets. Each role maps to an array of dotted
 * selector paths to remove from the composed output for that role.
 *
 * v2 keys redactions by role; M5 will rekey by capability triple.
 */
export type ProjectionRedactions = Readonly<Record<string, readonly string[]>>;

// ── Declaration shape ────────────────────────────────────────

export interface ProjectionDeclaration {
  /** Stable kebab-case identifier referenced from composers, manifests, agent tools. */
  readonly name: string;

  /** Route / call params the projection consumes. */
  readonly params?: ProjectionParams;

  /** Selector tree — declarative description of which entities + fields. */
  readonly selector: SelectorTree;

  /** Per-role redactions applied at compose time. */
  readonly redactions?: ProjectionRedactions;

  /**
   * Channel that carries diffs when entities inside the selector
   * mutate. Optional in Phase 0 — projections without a diff channel
   * are one-shot reads only. v2 makes this load-bearing for the
   * controller subscribe wiring.
   */
  readonly diffChannel?: ChannelDeclaration;

  /**
   * Free-form description. M4 agent introspection reads this to know
   * what each projection carries before composing one.
   */
  readonly description: string;
}

// ── Compose options ──────────────────────────────────────────

/**
 * Request context threaded into the composer. Selector references of
 * the form `ctx.X` resolve against this object. Common keys:
 *
 *   - `actorId`   — current member id; used by redactions + scopes.
 *   - `actorRole` — picks the redaction set; absent role → no
 *                   redactions applied.
 *   - `lang`      — active language for translatable fields.
 */
export type ComposeContext = Readonly<Record<string, unknown>>;

export interface ComposeOptions {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly ctx?: ComposeContext;
}

// ── Compose result ───────────────────────────────────────────

/**
 * The shape returned by `compose()`. Plain JSON (no class instances)
 * so it serializes cleanly into SSR initial-state script tags and
 * over the diff channel.
 *
 * For `byId` / `where` roots: `value` is the composed record or `null`
 * if the root didn't resolve.
 *
 * For `list: true` roots: `value` is an array of composed records.
 */
export type ComposedValue = Readonly<Record<string, unknown>> | null | readonly Readonly<Record<string, unknown>>[];
