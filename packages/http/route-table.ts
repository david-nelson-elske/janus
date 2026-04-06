/**
 * Route table derivation — reads the dispatch index and produces RouteEntry[].
 *
 * Derives REST routes from compiled entity operations. Consumer entities only
 * (framework-origin entities like execution_log are skipped).
 */

import type { CompileResult } from '@janus/core';

export interface RouteEntry {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly entity: string;
  readonly operation: string;
}

/**
 * Derive HTTP routes from the compiled dispatch index for a given initiator.
 */
export function deriveRouteTable(
  registry: CompileResult,
  initiator: string,
  basePath: string,
): readonly RouteEntry[] {
  const routes: RouteEntry[] = [];
  const base = basePath.replace(/\/$/, ''); // strip trailing slash

  for (const [name, node] of registry.graphNodes) {
    // Skip framework-origin entities
    if (node.origin === 'framework') continue;

    const plural = `${name}s`;

    for (const operation of node.operations) {
      // Check that a pipeline exists for this (initiator, entity, operation)
      if (!registry.pipeline(initiator, name, operation)) continue;

      switch (operation) {
        case 'read':
          routes.push({ method: 'GET', path: `${base}/${plural}`, entity: name, operation: 'read' });
          routes.push({ method: 'GET', path: `${base}/${plural}/:id`, entity: name, operation: 'read' });
          break;
        case 'create':
          routes.push({ method: 'POST', path: `${base}/${plural}`, entity: name, operation: 'create' });
          break;
        case 'update':
          routes.push({ method: 'PATCH', path: `${base}/${plural}/:id`, entity: name, operation: 'update' });
          break;
        case 'delete':
          routes.push({ method: 'DELETE', path: `${base}/${plural}/:id`, entity: name, operation: 'delete' });
          break;
      }
    }

    // Lifecycle transitions → POST /{plural}/:id/{action}
    for (const target of node.transitionTargets) {
      if (!registry.pipeline(initiator, name, target.name)) continue;
      routes.push({
        method: 'POST',
        path: `${base}/${plural}/:id/${target.name}`,
        entity: name,
        operation: target.name,
      });
    }
  }

  return Object.freeze(routes);
}
