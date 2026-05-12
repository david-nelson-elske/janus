/**
 * Projection registry — the closed set of projections an app exposes.
 *
 * Mirrors the channel + controller registry pattern: the app composes
 * a single barrel mapping kebab-case projection name → declaration.
 * The composer, the diff publisher, the manifest emitter, and M4's
 * agent introspection all look up by name from here.
 *
 * Per `.planning/PROJECTION-DECLARATIONS.md` §5 "The registry".
 */

import type { ProjectionDeclaration } from './types';

export type ProjectionRegistry = Readonly<Record<string, ProjectionDeclaration>>;

/**
 * Look up a projection declaration by name. Throws
 * `UnknownProjectionError` rather than returning `undefined` — every
 * composer / publisher call site that misses the registry is a bug,
 * and silent fallbacks hide misnames behind blank screens.
 */
export function lookupProjection(
  registry: ProjectionRegistry,
  name: string,
): ProjectionDeclaration {
  const decl = registry[name];
  if (!decl) {
    throw new UnknownProjectionError(name, Object.keys(registry));
  }
  return decl;
}

export class UnknownProjectionError extends Error {
  override readonly name = 'UnknownProjectionError';
  constructor(readonly projectionName: string, readonly known: readonly string[]) {
    super(
      `Unknown projection "${projectionName}". Registered: [${known.join(', ') || '<empty>'}]`,
    );
  }
}
