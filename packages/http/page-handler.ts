/**
 * Page handler — SSR page serving via Hono catch-all route.
 *
 * Resolves URL → entity + view, loads data through the dispatch pipeline,
 * builds binding contexts, renders Preact SSR, and returns HTML.
 */

import type { Context } from 'hono';
import type { CompileResult, Identity } from '@janus/core';
import { SYSTEM } from '@janus/core';
import { createBindingContext } from '@janus/client';
import type { BindingContext } from '@janus/client';
import type { DispatchRuntime } from '@janus/pipeline';
import { resolvePageRoute } from './page-router';
import { renderPage } from './ssr-renderer';

export interface PageHandlerConfig {
  readonly registry: CompileResult;
  readonly runtime: DispatchRuntime;
}

/**
 * Create a Hono handler that serves SSR pages for entity views.
 */
export function createPageHandler(config: PageHandlerConfig) {
  const { registry, runtime } = config;

  return async (c: Context) => {
    const path = new URL(c.req.url).pathname;
    const route = resolvePageRoute(path, registry);

    if (!route) {
      return c.notFound();
    }

    const identity: Identity = SYSTEM; // TODO: resolve from request
    const binding = registry.bindingIndex.byEntityAndView(route.entity, route.view);
    if (!binding) {
      return c.notFound();
    }

    // Load data through the dispatch pipeline
    const node = registry.entity(route.entity)!;

    if (route.view === 'list') {
      // List view — read all records
      const response = await runtime.dispatch(
        'system', route.entity, 'read', {}, identity,
      );

      if (!response.ok) {
        return c.html(renderErrorPage(response.error?.message ?? 'Failed to load data'), 500);
      }

      const page = response.data as { records: readonly Record<string, unknown>[]; total?: number; hasMore: boolean };

      // Build a minimal binding context for the list (fields from first record or empty)
      const firstRecord = page.records[0] ?? {};
      const ctx = createBindingContext(
        route.entity, null, 'list', binding, firstRecord, node.schema,
      );

      // Render with the component, passing the page data
      const Component = binding.component as any;
      const html = renderPage({
        registry,
        contexts: [ctx],
        binding: {
          ...binding,
          component: (props: any) => Component({ ...props, page, records: page.records }),
        },
        title: `${route.entity}s`,
      });

      return c.html(html);
    }

    // Detail view — read single record
    const response = await runtime.dispatch(
      'system', route.entity, 'read', { id: route.id }, identity,
    );

    if (!response.ok) {
      if (response.error?.kind === 'not-found') {
        return c.notFound();
      }
      return c.html(renderErrorPage(response.error?.message ?? 'Failed to load data'), 500);
    }

    const record = response.data as Record<string, unknown>;
    const ctx = createBindingContext(
      route.entity, route.id, 'detail', binding, record, node.schema,
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding,
      title: String(record.title ?? route.entity),
    });

    return c.html(html);
  };
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Error</title></head>
<body><h1>Error</h1><p>${message}</p></body></html>`;
}
