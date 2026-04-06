/**
 * Page router — resolves URLs to entity + view + id for SSR.
 *
 * Convention:
 *   /              → first entity with a "list" binding
 *   /{entities}    → entity list view
 *   /{entities}/:id → entity detail view
 *
 * Uses the BindingIndex + GraphNodeRecord to determine valid routes.
 */

import type { CompileResult } from '@janus/core';

export interface PageRoute {
  readonly entity: string;
  readonly view: string;
  readonly id: string | null;
}

/**
 * Resolve a URL path to a page route.
 * Returns undefined if no matching entity/binding is found.
 */
export function resolvePageRoute(
  path: string,
  registry: CompileResult,
): PageRoute | undefined {
  const segments = path.split('/').filter(Boolean);

  // / → root: find first consumer entity with a list binding
  if (segments.length === 0) {
    for (const [name, node] of registry.graphNodes) {
      if (node.origin === 'framework') continue;
      if (registry.bindingIndex.byEntityAndView(name, 'list')) {
        return { entity: name, view: 'list', id: null };
      }
    }
    return undefined;
  }

  // /{plural} or /{plural}/:id
  const plural = segments[0];
  const id = segments[1] ?? null;

  // Try to match plural to an entity name (entities use singular, routes use plural)
  const entityName = findEntityByPlural(plural, registry);
  if (!entityName) return undefined;

  const view = id ? 'detail' : 'list';
  const binding = registry.bindingIndex.byEntityAndView(entityName, view);
  if (!binding) return undefined;

  return { entity: entityName, view, id };
}

/**
 * Find entity name from plural form.
 * Convention: entity "task" → plural "tasks"
 */
function findEntityByPlural(plural: string, registry: CompileResult): string | undefined {
  for (const [name, node] of registry.graphNodes) {
    if (node.origin === 'framework') continue;
    if (`${name}s` === plural) return name;
  }
  return undefined;
}

/**
 * Build navigation links for all entities with list bindings.
 */
export function buildNavLinks(registry: CompileResult): readonly { entity: string; href: string; label: string }[] {
  const links: { entity: string; href: string; label: string }[] = [];
  for (const [name, node] of registry.graphNodes) {
    if (node.origin === 'framework') continue;
    if (registry.bindingIndex.byEntityAndView(name, 'list')) {
      links.push({
        entity: name,
        href: `/${name}s`,
        label: name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) + 's',
      });
    }
  }
  return links;
}
