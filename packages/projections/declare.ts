/**
 * Projection declaration — pure-data, compile-time fact about a
 * server-side projection: its name, params, selector tree, per-role
 * redactions, optional diff channel, and human description.
 *
 * Per `.planning/PROJECTION-DECLARATIONS.md` §5 of Perspicuity.
 */

import type {
  ProjectionDeclaration,
  RelationSpec,
  RootSpec,
  SelectorTree,
} from './types';

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const PARAM_TYPES = new Set(['string', 'number', 'boolean']);
const DEFAULT_MAX_DEPTH = 4;

/**
 * Declare a projection. Returns the same object (typed); the function
 * exists to enforce shape at the call site and to give us a single
 * place to add validation later.
 *
 * Usage mirrors `declareChannel`:
 *
 *   export const decisionDocView = declareProjection({
 *     name: 'decision-doc-view',
 *     params: { decisionId: 'string' } as const,
 *     selector: select({ root: { entity: 'decision', byId: { from: 'params.decisionId' } }, fields: ['id', 'title'] }),
 *     diffChannel: decisionUpdated,
 *     description: 'The decision document tree as the owner views it.',
 *   } as const);
 */
export function declareProjection<T extends ProjectionDeclaration>(decl: T): T {
  validateDeclaration(decl);
  return decl;
}

/**
 * Selector builder — accepts the selector tree as-is. Exists so that
 * call sites read uniformly (`selector: select({ ... })`) and so we
 * can introduce computed fields / shorthand later without churning
 * every declaration.
 */
export function select<T extends SelectorTree>(tree: T): T {
  return tree;
}

function validateDeclaration(decl: ProjectionDeclaration): void {
  if (!NAME_PATTERN.test(decl.name)) {
    throw new Error(
      `[declareProjection] invalid name "${decl.name}" — must be kebab-case starting with a letter`,
    );
  }

  if (!decl.description || decl.description.trim().length === 0) {
    throw new Error(
      `[declareProjection:${decl.name}] description is required (used by M4 agent introspection)`,
    );
  }

  if (decl.params) {
    for (const [key, type] of Object.entries(decl.params)) {
      if (!KEY_PATTERN.test(key)) {
        throw new Error(
          `[declareProjection:${decl.name}] invalid param key "${key}" — must be camelCase`,
        );
      }
      if (!PARAM_TYPES.has(type)) {
        throw new Error(
          `[declareProjection:${decl.name}] invalid param type "${type}" for "${key}" (allowed: string | number | boolean)`,
        );
      }
    }
  }

  validateSelector(decl.name, decl.selector);

  if (decl.redactions) {
    for (const [role, paths] of Object.entries(decl.redactions)) {
      if (!Array.isArray(paths)) {
        throw new Error(
          `[declareProjection:${decl.name}] redactions.${role} must be a readonly string array`,
        );
      }
      for (const path of paths) {
        if (typeof path !== 'string' || path.length === 0) {
          throw new Error(
            `[declareProjection:${decl.name}] redactions.${role} contains an invalid path`,
          );
        }
      }
    }
  }
}

function validateSelector(declName: string, selector: SelectorTree): void {
  validateRoot(declName, selector.root);
  validateFields(declName, selector.fields, 'root');
  const maxDepth = selector.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(
      `[declareProjection:${declName}] selector.maxDepth must be a positive integer`,
    );
  }
  if (selector.relations) {
    walkRelations(declName, selector.relations, 1, maxDepth, 'root');
  }
  if (selector.aggregates) {
    validateAggregates(declName, selector.aggregates, selector.relations, 'root');
  }
}

function validateRoot(declName: string, root: RootSpec): void {
  if (!root.entity || typeof root.entity !== 'string') {
    throw new Error(`[declareProjection:${declName}] selector.root.entity is required`);
  }
  const isById = 'byId' in root;
  const isWhere = 'where' in root && !('list' in root);
  const isList = 'list' in root && root.list === true;
  const matched = [isById, isWhere, isList].filter(Boolean).length;
  if (matched !== 1) {
    throw new Error(
      `[declareProjection:${declName}] selector.root must be exactly one of byId / where / list`,
    );
  }
}

function validateFields(
  declName: string,
  fields: readonly string[],
  where: string,
): void {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error(
      `[declareProjection:${declName}] ${where}.fields must be a non-empty array`,
    );
  }
  for (const f of fields) {
    if (typeof f !== 'string' || !KEY_PATTERN.test(f)) {
      throw new Error(
        `[declareProjection:${declName}] ${where}.fields contains invalid field "${f}"`,
      );
    }
  }
}

function walkRelations(
  declName: string,
  relations: Readonly<Record<string, RelationSpec>>,
  depth: number,
  maxDepth: number,
  parentPath: string,
): void {
  if (depth > maxDepth) {
    throw new Error(
      `[declareProjection:${declName}] selector depth exceeds maxDepth (${maxDepth}) at ${parentPath}`,
    );
  }
  for (const [name, rel] of Object.entries(relations)) {
    if (!KEY_PATTERN.test(name)) {
      throw new Error(
        `[declareProjection:${declName}] relation name "${name}" must be camelCase (under ${parentPath})`,
      );
    }
    if (!rel.from || typeof rel.from !== 'string') {
      throw new Error(
        `[declareProjection:${declName}] relation "${parentPath}.${name}" must declare from: '<entity>'`,
      );
    }
    if (!['hasMany', 'belongsTo', 'hasOne'].includes(rel.kind)) {
      throw new Error(
        `[declareProjection:${declName}] relation "${parentPath}.${name}" has invalid kind "${rel.kind}"`,
      );
    }
    validateFields(declName, rel.fields, `${parentPath}.${name}`);
    if (rel.relations) {
      walkRelations(declName, rel.relations, depth + 1, maxDepth, `${parentPath}.${name}`);
    }
    if (rel.aggregates) {
      validateAggregates(declName, rel.aggregates, rel.relations, `${parentPath}.${name}`);
    }
  }
}

function validateAggregates(
  declName: string,
  aggregates: Readonly<Record<string, { kind: string; relation: string }>>,
  relations: Readonly<Record<string, RelationSpec>> | undefined,
  parentPath: string,
): void {
  for (const [name, agg] of Object.entries(aggregates)) {
    if (!KEY_PATTERN.test(name)) {
      throw new Error(
        `[declareProjection:${declName}] aggregate name "${name}" must be camelCase (under ${parentPath})`,
      );
    }
    if (!['count', 'exists'].includes(agg.kind)) {
      throw new Error(
        `[declareProjection:${declName}] aggregate "${parentPath}.${name}" has invalid kind "${agg.kind}" (allowed: count | exists)`,
      );
    }
    if (!relations || !(agg.relation in relations)) {
      throw new Error(
        `[declareProjection:${declName}] aggregate "${parentPath}.${name}" references unknown relation "${agg.relation}"`,
      );
    }
  }
}
