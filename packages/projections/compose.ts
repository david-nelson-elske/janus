/**
 * Projection composer — walks a projection's selector tree against an
 * EntityStore and assembles the typed result.
 *
 * Per `.planning/PROJECTION-DECLARATIONS.md` §8.
 *
 * Phase 0 scope:
 *   - Root resolution: byId / where / list
 *   - Relation walks: hasMany / belongsTo / hasOne (batched by parent id)
 *   - Field projection (drop columns not in `fields`)
 *   - Reference resolution: params.X / ctx.X / parent.X / root.X
 *   - Aggregates: count / exists
 *   - Per-role redactions (dotted paths)
 *
 * Phase 0 defers:
 *   - Cursor pagination (spec §7) — list reads return the full set
 *     within the optional limit. Real keyset cursors land with the
 *     first list-shape projection migration.
 *   - Compose-time version tag — added when the diff publisher needs
 *     it (Phase 0 builds the publisher infrastructure but doesn't
 *     stamp versions on the bare compose() yet).
 */

import type {
  EntityRecord,
  EntityStore,
  ReadPage,
  SortClause,
} from '@janus/core';
import type { FieldFilter, WhereClause } from '@janus/store';
import type {
  AggregateSpec,
  ComposeContext,
  ComposeOptions,
  ComposedValue,
  ProjectionDeclaration,
  RelationSpec,
  RootSpec,
  SelectorTree,
  SelectorWhereClause,
  SelectorWhereValue,
} from './types';

// ── Public API ───────────────────────────────────────────────────

export interface Composer {
  compose<D extends ProjectionDeclaration>(
    decl: D,
    opts: ComposeOptions,
  ): Promise<ComposedValue>;
}

export interface ComposerConfig {
  readonly store: EntityStore;
}

/**
 * Build a composer bound to a single EntityStore. Apps typically
 * construct one composer at boot and reuse it for every loader /
 * refresh / agent tool call.
 */
export function createComposer(config: ComposerConfig): Composer {
  return {
    compose: (decl, opts) => composeWithStore(config.store, decl, opts),
  };
}

/**
 * One-shot compose. Equivalent to
 * `createComposer({ store }).compose(decl, opts)` — convenient for
 * tests and one-off scripts.
 */
export async function compose<D extends ProjectionDeclaration>(
  store: EntityStore,
  decl: D,
  opts: ComposeOptions,
): Promise<ComposedValue> {
  return composeWithStore(store, decl, opts);
}

// ── Implementation ───────────────────────────────────────────────

async function composeWithStore(
  store: EntityStore,
  decl: ProjectionDeclaration,
  opts: ComposeOptions,
): Promise<ComposedValue> {
  validateParams(decl, opts);

  const ctx = opts.ctx ?? {};
  const params = opts.params ?? {};

  const result = await resolveRoot(store, decl.selector, { params, ctx });
  if (result === null) return null;

  const composed = await expandRelations(store, result, decl.selector, { params, ctx });

  if (decl.redactions && ctx.actorRole) {
    const role = String(ctx.actorRole);
    const paths = decl.redactions[role];
    if (paths) applyRedactions(composed, paths);
  }

  return composed;
}

// ── Param + ctx scaffolding ─────────────────────────────────────

interface ResolverScope {
  readonly params: Readonly<Record<string, unknown>>;
  readonly ctx: ComposeContext;
}

function validateParams(decl: ProjectionDeclaration, opts: ComposeOptions): void {
  if (!decl.params) return;
  const supplied = opts.params ?? {};
  for (const [key, type] of Object.entries(decl.params)) {
    const value = supplied[key];
    if (value === undefined || value === null) {
      throw new Error(
        `[compose:${decl.name}] missing required param "${key}"`,
      );
    }
    const valid =
      (type === 'string' && typeof value === 'string') ||
      (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (type === 'boolean' && typeof value === 'boolean');
    if (!valid) {
      throw new Error(
        `[compose:${decl.name}] param "${key}" has wrong type (expected ${type})`,
      );
    }
  }
}

// ── Root resolution ─────────────────────────────────────────────

type ComposedRecord = Record<string, unknown>;

async function resolveRoot(
  store: EntityStore,
  selector: SelectorTree,
  scope: ResolverScope,
): Promise<ComposedRecord | readonly ComposedRecord[] | null> {
  const root = selector.root;

  if ('byId' in root) {
    const id = resolveReference(root.byId, scope, null);
    if (id == null) return null;
    const rec = await readById(store, root.entity, String(id));
    if (!rec) return null;
    return projectFields(rec, selector.fields);
  }

  if ('list' in root) {
    return resolveListRoot(store, root, selector.fields, scope);
  }

  // where
  const where = resolveWhere(root.where, scope, null);
  const page = await readPage(store, root.entity, { where });
  if (page.records.length === 0) return null;
  if (page.records.length > 1) {
    throw new Error(
      `[compose] root "${root.entity}" matched ${page.records.length} records — use list:true if a set is intended`,
    );
  }
  return projectFields(page.records[0], selector.fields);
}

async function resolveListRoot(
  store: EntityStore,
  root: Extract<RootSpec, { list: true }>,
  fields: readonly string[],
  scope: ResolverScope,
): Promise<readonly ComposedRecord[]> {
  const where = root.where ? resolveWhere(root.where, scope, null) : undefined;
  const params: { where?: WhereClause; sort?: readonly SortClause[]; limit?: number } = {};
  if (where) params.where = where;
  if (root.sort) params.sort = root.sort;
  if (root.limit !== undefined) params.limit = root.limit;
  const page = await readPage(store, root.entity, params);
  return page.records.map((r: EntityRecord) => projectFields(r, fields));
}

// ── Relation walk ───────────────────────────────────────────────

async function expandRelations(
  store: EntityStore,
  rootValue: ComposedRecord | readonly ComposedRecord[],
  selector: SelectorTree,
  scope: ResolverScope,
): Promise<ComposedValue> {
  const roots: ComposedRecord[] = Array.isArray(rootValue)
    ? (rootValue as ComposedRecord[]).map(cloneRecord)
    : [cloneRecord(rootValue as ComposedRecord)];

  // Each root carries its own resolved view; selector.root is the
  // shared `root.X` reference target for descendants.
  for (const rec of roots) {
    if (selector.relations) {
      await expandRelationLayer(store, [rec], selector.relations, scope, rec);
    }
    if (selector.aggregates) {
      await expandAggregates(store, [rec], selector.aggregates, selector.relations, scope, rec);
    }
  }

  if (Array.isArray(rootValue)) return roots;
  return roots[0] ?? null;
}

async function expandRelationLayer(
  store: EntityStore,
  parents: ComposedRecord[],
  relations: Readonly<Record<string, RelationSpec>>,
  scope: ResolverScope,
  rootValue: ComposedRecord,
): Promise<void> {
  for (const [name, rel] of Object.entries(relations)) {
    await expandOneRelation(store, parents, name, rel, scope, rootValue);
  }
}

async function expandOneRelation(
  store: EntityStore,
  parents: ComposedRecord[],
  name: string,
  rel: RelationSpec,
  scope: ResolverScope,
  rootValue: ComposedRecord,
): Promise<void> {
  // The relation's `where` clause may reference `parent.X` — we
  // expand per-parent rather than batching across parents in Phase 0.
  // Spec §6 calls for parent-batched reads via `$in`; we ship the
  // simpler per-parent version first since correctness > N+1 tuning
  // for the small graphs perspicuity sees today.
  for (const parent of parents) {
    const where = rel.where ? resolveWhere(rel.where, scope, parent, rootValue) : {};
    const params: { where?: WhereClause; sort?: readonly SortClause[]; limit?: number } = {};
    if (Object.keys(where).length > 0) params.where = where;
    if (rel.sort) params.sort = rel.sort;
    if (rel.limit !== undefined) params.limit = rel.limit;

    const page = await readPage(store, rel.from, params);
    const records = page.records.map((r: EntityRecord) => projectFields(r, rel.fields));

    let value: ComposedRecord | ComposedRecord[] | null;
    if (rel.kind === 'hasMany') {
      value = records;
    } else {
      // belongsTo / hasOne: take the first if any.
      value = records[0] ?? null;
    }
    parent[name] = value;

    // Recurse into nested relations.
    if (rel.relations) {
      const children: ComposedRecord[] = Array.isArray(value)
        ? value
        : value
          ? [value]
          : [];
      if (children.length > 0) {
        await expandRelationLayer(store, children, rel.relations, scope, rootValue);
      }
    }
    if (rel.aggregates) {
      const children: ComposedRecord[] = Array.isArray(value)
        ? value
        : value
          ? [value]
          : [];
      if (children.length > 0) {
        await expandAggregates(store, children, rel.aggregates, rel.relations, scope, rootValue);
      }
    }
  }
}

// ── Aggregates ──────────────────────────────────────────────────

async function expandAggregates(
  store: EntityStore,
  parents: ComposedRecord[],
  aggregates: Readonly<Record<string, AggregateSpec>>,
  relations: Readonly<Record<string, RelationSpec>> | undefined,
  scope: ResolverScope,
  rootValue: ComposedRecord,
): Promise<void> {
  for (const [name, agg] of Object.entries(aggregates)) {
    const rel = relations?.[agg.relation];
    if (!rel) {
      // Defensive — validation should have caught this at declare time.
      throw new Error(`[compose] aggregate "${name}" references unknown relation "${agg.relation}"`);
    }
    for (const parent of parents) {
      const where = rel.where ? resolveWhere(rel.where, scope, parent, rootValue) : {};
      if (agg.kind === 'count') {
        const n = await store.count(rel.from, where);
        parent[name] = n;
      } else {
        // exists
        const page = await readPage(store, rel.from, { where, limit: 1 });
        parent[name] = page.records.length > 0;
      }
    }
  }
}

// ── Reference + where resolution ────────────────────────────────

function resolveReference(
  ref: SelectorWhereValue,
  scope: ResolverScope,
  parent: ComposedRecord | null,
  rootValue?: ComposedRecord,
): unknown {
  if (typeof ref === 'object' && ref !== null && !Array.isArray(ref)) {
    if ('from' in ref) {
      return resolveDottedPath(String(ref.from), scope, parent, rootValue);
    }
    if ('ref' in ref) {
      // `{ ref: 'parent.X' }` shorthand — resolve verbatim.
      return resolveDottedPath(String(ref.ref), scope, parent, rootValue);
    }
  }
  return ref;
}

function resolveDottedPath(
  path: string,
  scope: ResolverScope,
  parent: ComposedRecord | null,
  rootValue?: ComposedRecord,
): unknown {
  const dot = path.indexOf('.');
  if (dot < 0) {
    throw new Error(`[compose] reference "${path}" must be a dotted path (params.X / ctx.X / parent.X / root.X)`);
  }
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  switch (head) {
    case 'params':
      return readNested(scope.params, tail);
    case 'ctx':
      return readNested(scope.ctx as Record<string, unknown>, tail);
    case 'parent':
      if (!parent) {
        throw new Error(`[compose] reference "${path}" uses parent.* outside a relation`);
      }
      return readNested(parent, tail);
    case 'root':
      if (!rootValue) {
        throw new Error(`[compose] reference "${path}" uses root.* outside the root scope`);
      }
      return readNested(rootValue, tail);
    default:
      throw new Error(`[compose] reference "${path}" has unknown head "${head}"`);
  }
}

function readNested(obj: Record<string, unknown> | undefined, path: string): unknown {
  if (!obj) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function resolveWhere(
  where: SelectorWhereClause,
  scope: ResolverScope,
  parent: ComposedRecord | null,
  rootValue?: ComposedRecord,
): WhereClause {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(where)) {
    out[field] = resolveWhereValue(value, scope, parent, rootValue);
  }
  return out as WhereClause;
}

function resolveWhereValue(
  value: SelectorWhereValue,
  scope: ResolverScope,
  parent: ComposedRecord | null,
  rootValue: ComposedRecord | undefined,
): unknown {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if ('from' in obj || 'ref' in obj) {
    return resolveReference(value as SelectorWhereValue, scope, parent, rootValue);
  }
  // operator object — recurse into operand values that may reference.
  const resolved: Record<string, unknown> = {};
  for (const [op, operand] of Object.entries(obj)) {
    if (op === '$in' || op === '$nin' || op === '$inOrNull') {
      if (Array.isArray(operand)) {
        resolved[op] = operand.map((v) =>
          isReferenceLike(v) ? resolveReference(v as SelectorWhereValue, scope, parent, rootValue) : v,
        );
      } else {
        resolved[op] = operand;
      }
      continue;
    }
    resolved[op] = isReferenceLike(operand)
      ? resolveReference(operand as SelectorWhereValue, scope, parent, rootValue)
      : operand;
  }
  return resolved as FieldFilter;
}

function isReferenceLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('from' in (value as object) || 'ref' in (value as object))
  );
}

// ── Field projection + redaction ────────────────────────────────

function projectFields(record: EntityRecord, fields: readonly string[]): ComposedRecord {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in record) out[f] = record[f];
    else out[f] = undefined;
  }
  return out;
}

function cloneRecord(rec: ComposedRecord): ComposedRecord {
  return { ...rec };
}

/**
 * Apply a redaction set in place. Each path is dot-separated. `a.b.c`
 * walks `a` then `b` then deletes `c`. When a step hits an array, the
 * remainder of the path is applied to every element.
 */
function applyRedactions(value: ComposedValue, paths: readonly string[]): void {
  for (const path of paths) {
    removeAtPath(value, path.split('.'));
  }
}

function removeAtPath(target: unknown, segments: readonly string[]): void {
  if (segments.length === 0) return;
  if (target === null || target === undefined) return;
  if (Array.isArray(target)) {
    for (const item of target) removeAtPath(item, segments);
    return;
  }
  if (typeof target !== 'object') return;
  const obj = target as Record<string, unknown>;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    delete obj[head];
    return;
  }
  removeAtPath(obj[head], rest);
}

// ── Store read helpers ──────────────────────────────────────────

async function readById(
  store: EntityStore,
  entity: string,
  id: string,
): Promise<EntityRecord | null> {
  const result = await store.read(entity, { id });
  if (!result) return null;
  if (Array.isArray((result as ReadPage).records)) {
    const records = (result as ReadPage).records;
    return records[0] ?? null;
  }
  return result as EntityRecord;
}

async function readPage(
  store: EntityStore,
  entity: string,
  params: { where?: WhereClause; sort?: readonly SortClause[]; limit?: number },
): Promise<ReadPage> {
  const result = await store.read(entity, params);
  if (Array.isArray((result as ReadPage).records)) {
    return result as ReadPage;
  }
  // Defensive: a single-record adapter return — wrap as page.
  return {
    records: result ? [result as EntityRecord] : [],
    hasMore: false,
  };
}
