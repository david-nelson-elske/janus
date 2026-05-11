/**
 * Controller registry — the closed set of controllers an app exposes.
 *
 * The registry is built by the app (Perspicuity, etc.) by importing
 * each controller declaration and exporting them under a stable keyed
 * map. The router and manifest emitter consult the registry to
 * validate that any controller referenced by a loader actually exists.
 *
 * Per spec §5 "The registry" of CONTROLLER-API-AND-ROUTER.md.
 */

import type { ControllerDeclaration } from './declare';

export type ControllerRegistry = Readonly<Record<string, ControllerDeclaration>>;

/**
 * Look up a controller declaration by name.
 *
 * Throws `UnknownControllerError` when the name isn't in the registry —
 * better to fail fast at compose time than emit a bad manifest.
 */
export function lookupController(
  registry: ControllerRegistry,
  name: string,
): ControllerDeclaration {
  const decl = registry[name];
  if (!decl) {
    throw new UnknownControllerError(name, Object.keys(registry));
  }
  return decl;
}

export class UnknownControllerError extends Error {
  readonly name = 'UnknownControllerError';
  constructor(readonly controllerName: string, readonly known: readonly string[]) {
    super(
      `Unknown controller "${controllerName}". Registered: [${known.join(', ') || '<empty>'}]`,
    );
  }
}
