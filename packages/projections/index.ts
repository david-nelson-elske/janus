/**
 * @janus/projections — v2 projection primitives.
 *
 * Spec: `.planning/PROJECTION-DECLARATIONS.md` (in Perspicuity).
 *
 * Phase 0 surface: declaration, registry, compose runtime, JSON Patch
 * diff helper, diff publisher that wires the broker → channel publish
 * loop. No projections are declared by Janus itself; apps construct
 * their own `PROJECTION_REGISTRY` and pass it to the runtime.
 */

// Declarations + types
export { declareProjection, select } from './declare';
export type {
  AggregateCount,
  AggregateExists,
  AggregateSpec,
  ComposeContext,
  ComposeOptions,
  ComposedValue,
  FromRef,
  ParentRef,
  ProjectionDeclaration,
  ProjectionParamType,
  ProjectionParams,
  ProjectionRedactions,
  Reference,
  RelationKind,
  RelationSpec,
  RootByIdSpec,
  RootListSpec,
  RootSpec,
  RootWhereSpec,
  SelectorTree,
  SelectorWhereClause,
  SelectorWhereValue,
} from './types';

// Registry
export { lookupProjection, UnknownProjectionError } from './registry';
export type { ProjectionRegistry } from './registry';

// Compose runtime
export { compose, createComposer } from './compose';
export type { Composer, ComposerConfig } from './compose';

// JSON Patch diff
export { diff, diffComposed } from './patch';
export type { JsonPatch, JsonPatchOp, PatchOpAdd, PatchOpRemove, PatchOpReplace } from './patch';

// Diff publisher
export { collectSelectorEntities, createDiffPublisher } from './publisher';
export type { DiffPublisher, DiffPublisherConfig, WatchHandle } from './publisher';
