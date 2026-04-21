/**
 * Page handler — SSR page serving via Hono catch-all route.
 *
 * Resolves URL → entity + view, loads data through the dispatch pipeline,
 * builds binding contexts, renders Preact SSR, and returns HTML.
 *
 * Per ADR-124-12c, list views accept `?limit=`, `?offset=`, `?sort=`,
 * `?search=`, and `?where.field=value` query params which flow into the
 * dispatch input. Theme + layout overrides are threaded from createApp.
 */

import { createBindingContext } from '@janus/client';
import type { CompileResult, Identity } from '@janus/core';
import { ANONYMOUS } from '@janus/core';
import type { DispatchRuntime } from '@janus/pipeline';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE } from './auth-routes';
import { resolvePageRoute } from './page-router';
import { resolveSessionIdentity } from './session-resolve';
import { type LayoutConfig, renderPage, type ThemeConfig } from './ssr-renderer';

export interface PageHandlerConfig {
  readonly registry: CompileResult;
  readonly runtime: DispatchRuntime;
  readonly theme?: ThemeConfig;
  readonly layout?: LayoutConfig;
}

/**
 * Create a Hono handler that serves SSR pages for entity views.
 */
export function createPageHandler(config: PageHandlerConfig) {
  const { registry, runtime, theme, layout } = config;

  return async (c: Context) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const route = resolvePageRoute(path, registry);

    if (!route) {
      return c.notFound();
    }

    // Resolve identity from session cookie, fall back to ANONYMOUS
    let identity: Identity = ANONYMOUS;
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (sessionToken) {
      const resolved = await resolveSessionIdentity(runtime, sessionToken);
      if (resolved) identity = resolved;
    }
    const binding = registry.bindingIndex.byEntityAndView(route.entity, route.view);
    if (!binding) {
      return c.notFound();
    }

    // Load data through the dispatch pipeline
    const node = registry.entity(route.entity)!;

    if (route.view === 'list') {
      // List view — parse query params into dispatch input (ADR-12c)
      const readInput = parseListQueryParams(url.searchParams);

      const response = await runtime.dispatch('system', route.entity, 'read', readInput, identity);

      if (!response.ok) {
        return c.html(renderErrorPage(response.error?.message ?? 'Failed to load data'), 500);
      }

      const page = response.data as {
        records: readonly Record<string, unknown>[];
        total?: number;
        hasMore: boolean;
      };

      // Build a minimal binding context for the list (fields from first record or empty)
      const firstRecord = page.records[0] ?? {};
      const ctx = createBindingContext(
        route.entity,
        null,
        'list',
        binding,
        firstRecord,
        node.schema,
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
        path,
        identity,
        theme,
        layout,
      });

      return c.html(html);
    }

    // Detail view — read single record
    const response = await runtime.dispatch(
      'system',
      route.entity,
      'read',
      { id: route.id },
      identity,
    );

    if (!response.ok) {
      if (response.error?.kind === 'not-found') {
        return c.notFound();
      }
      return c.html(renderErrorPage(response.error?.message ?? 'Failed to load data'), 500);
    }

    const record = response.data as Record<string, unknown>;
    const ctx = createBindingContext(
      route.entity,
      route.id,
      'detail',
      binding,
      record,
      node.schema,
    );

    const html = renderPage({
      registry,
      contexts: [ctx],
      binding,
      title: String(record.title ?? route.entity),
      path,
      identity,
      theme,
      layout,
    });

    return c.html(html);
  };
}

// ── Query param parsing (ADR-124-12c §3) ───────────────────────────

const RESERVED_PARAMS = new Set(['limit', 'offset', 'sort', 'search']);

function coerceBool(value: string): string | boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value;
}

/**
 * Parse URL query params into a dispatch `read` input.
 *
 * Reserved: `limit`, `offset`, `sort`, `search`.
 * `where.<field>=<value>` accumulates into a `where` object.
 * Other params are ignored.
 */
export function parseListQueryParams(params: URLSearchParams): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const where: Record<string, unknown> = {};

  for (const [key, rawValue] of params) {
    if (key.startsWith('where.')) {
      const field = key.slice('where.'.length);
      if (field.length === 0) continue;
      where[field] = coerceBool(rawValue);
      continue;
    }

    if (!RESERVED_PARAMS.has(key)) continue;

    switch (key) {
      case 'limit': {
        const n = Number(rawValue);
        if (Number.isFinite(n) && n >= 0) input.limit = n;
        break;
      }
      case 'offset': {
        const n = Number(rawValue);
        if (Number.isFinite(n) && n >= 0) input.offset = n;
        break;
      }
      case 'sort': {
        input.sort = rawValue
          .split(',')
          .map((token) => token.trim())
          .filter((token) => token.length > 0)
          .map((token) =>
            token.startsWith('-')
              ? { field: token.slice(1), direction: 'desc' as const }
              : { field: token, direction: 'asc' as const },
          );
        break;
      }
      case 'search':
        input.search = rawValue;
        break;
    }
  }

  if (Object.keys(where).length > 0) input.where = where;
  return input;
}

// ── Error page ─────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Error</title></head>
<body><h1>Error</h1><p>${escapeHtml(message)}</p></body></html>`;
}
