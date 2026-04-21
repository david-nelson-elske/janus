/**
 * SSR renderer — Preact server-side rendering with document template.
 *
 * Renders a Preact component tree to HTML, wraps in a full HTML document,
 * and embeds serialized binding context data in window.__JANUS__.
 *
 * Per ADR-124-12c, accepts optional `theme` and `layout` overrides so
 * consumers can brand the document and replace the nav/shell without
 * abandoning the framework-derived page handler.
 */

import type { BindingContext, SerializedBindingContext } from '@janus/client';
import { serializeInitData } from '@janus/client';
import type { BindingRecord, CompileResult, Identity } from '@janus/core';
import { ANONYMOUS } from '@janus/core';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';
import { DefaultShell, MinimalShell, type ShellComponent } from './shells';

// ── Public types ───────────────────────────────────────────────────

export interface ThemeConfig {
  /** Inline CSS appended after the framework reset. When set, APP_STYLES is suppressed. */
  readonly css?: string;
  /** External stylesheet URL(s). Loaded with `<link rel="stylesheet">` in <head>. */
  readonly cssUrl?: string | readonly string[];
  /** Font configuration. When set, replaces the default Inter + JetBrains Mono links. */
  readonly fonts?: ThemeFontsConfig;
  /** Default document title. Page-specific titles (bindings) override. */
  readonly title?: string;
  /** Extra <head> content — favicon, meta tags, analytics. Rendered as-is, no escaping. */
  readonly headExtras?: string;
  /** <html lang> attribute. Default: 'en'. */
  readonly lang?: string;
}

export interface ThemeFontsConfig {
  readonly href: string;
  readonly preconnect?: readonly string[];
}

export interface LayoutConfig {
  /** Full-page wrapper component. Receives children + contextual data. */
  readonly shell?: ShellComponent;
  /** When true and no `shell`, render `#app + <main>` with no nav. */
  readonly suppressDefaultNav?: boolean;
}

export interface RenderPageConfig {
  readonly registry: CompileResult;
  readonly contexts: readonly BindingContext[];
  readonly binding: BindingRecord;
  readonly cursor?: string;
  readonly title?: string;
  readonly path?: string;
  readonly identity?: Identity;
  readonly theme?: ThemeConfig;
  readonly layout?: LayoutConfig;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Render a full HTML page from binding contexts.
 */
export function renderPage(config: RenderPageConfig): string {
  const { registry, contexts, binding, cursor, title, path, identity, theme, layout } = config;

  const Component = binding.component as ShellComponent;
  const mainCtx = contexts[0];
  const resolvedIdentity = identity ?? ANONYMOUS;
  const resolvedPath = path ?? '/';

  // ADR-124-12e: full-page mode — the binding component owns the whole
  // viewport. Skip the shell wrap entirely. `path`, `identity`, and
  // `registry` are handed to the component directly so it can build its
  // own chrome (nav, rails, footer). The document template (head, fonts,
  // theme CSS, __JANUS__ hydration) still wraps the output.
  if (binding.config.renderMode === 'full-page') {
    const componentVNode = h(
      Component as any,
      {
        contexts,
        context: mainCtx,
        fields: mainCtx?.fields,
        config: binding.config,
        path: resolvedPath,
        identity: resolvedIdentity,
        registry,
      } as any,
    );
    const appHtml = renderToString(componentVNode);
    const initData = serializeInitData(contexts, cursor);
    return renderDocument(appHtml, initData, title, theme);
  }

  const componentVNode = h(
    Component as unknown as ShellComponent,
    {
      contexts,
      context: mainCtx,
      fields: mainCtx?.fields,
      config: binding.config,
    } as unknown as Parameters<ShellComponent>[0],
  );

  const shellProps = {
    children: componentVNode,
    path: resolvedPath,
    identity: resolvedIdentity,
    registry,
  };

  let Shell: ShellComponent;
  if (layout?.shell) {
    Shell = layout.shell;
  } else if (layout?.suppressDefaultNav) {
    Shell = MinimalShell;
  } else {
    Shell = DefaultShell;
  }

  const appHtml = renderToString(h(Shell, shellProps));

  const initData = serializeInitData(contexts, cursor);

  return renderDocument(appHtml, initData, title, theme);
}

// ── Document template ──────────────────────────────────────────────

function renderDocument(
  appHtml: string,
  initData: { contexts: readonly SerializedBindingContext[]; cursor?: string },
  title?: string,
  theme?: ThemeConfig,
): string {
  const lang = theme?.lang ?? 'en';
  const pageTitle = title ?? theme?.title ?? 'Janus';
  const initJson = JSON.stringify(initData);

  const fontsHtml = theme?.fonts ? renderFonts(theme.fonts) : DEFAULT_FONTS_HTML;

  const cssUrls = theme?.cssUrl
    ? Array.isArray(theme.cssUrl)
      ? theme.cssUrl
      : [theme.cssUrl]
    : [];
  const cssUrlLinks = cssUrls
    .map((url) => `<link rel="stylesheet" href="${escapeHtml(url)}" />`)
    .join('\n  ');

  // theme.css replaces APP_STYLES (per ADR-12c); CSS_RESET is always present.
  const inlineStyles = theme?.css ? CSS_RESET + theme.css : CSS_RESET + APP_STYLES;

  const headExtras = theme?.headExtras ?? '';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  ${fontsHtml}
  ${cssUrlLinks}
  <style>${inlineStyles}</style>
  ${headExtras}
</head>
<body>
  ${appHtml}
  <script type="module">
    window.__JANUS__ = ${initJson};
  </script>
</body>
</html>`;
}

function renderFonts(fonts: ThemeFontsConfig): string {
  const preconnect = fonts.preconnect ?? [];
  const preconnectLinks = preconnect
    .map(
      (host, idx) =>
        `<link rel="preconnect" href="${escapeHtml(host)}"${idx > 0 ? ' crossorigin' : ''} />`,
    )
    .join('\n  ');
  const sheet = `<link href="${escapeHtml(fonts.href)}" rel="stylesheet" />`;
  return preconnect.length > 0 ? `${preconnectLinks}\n  ${sheet}` : sheet;
}

const DEFAULT_FONTS_HTML = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Styles ─────────────────────────────────────────────────────────

// ── DESIGN.md: Janus Design System (based on Linear) ──────────────
// See examples/dev-app/DESIGN.md for the full specification.

const CSS_RESET = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', 'SF Pro Display', -apple-system, system-ui, sans-serif;
    font-feature-settings: "cv01", "ss03";
    line-height: 1.55;
    color: #d4d4d8;
    background: #09090b;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  a { color: #2dd4bf; text-decoration: none; }
  a:hover { color: #5eead4; }
  code, .mono { font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace; }
`;

const APP_STYLES = `
  /* ── Navigation ─────────────────────────────────────────── */
  .janus-nav {
    display: flex; align-items: center; gap: 1.5rem;
    padding: 0 24px; height: 48px;
    background: #09090b;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .nav-brand {
    font-weight: 600; font-size: 14px; color: #fafafa;
    letter-spacing: -0.2px;
  }
  .nav-links { display: flex; gap: 4px; }
  .nav-link {
    color: #a1a1aa; font-size: 14px; font-weight: 500;
    padding: 6px 12px; border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  .nav-link:hover { color: #fafafa; background: rgba(255,255,255,0.06); }

  /* ── Layout ─────────────────────────────────────────────── */
  .janus-main { max-width: 1120px; margin: 0 auto; padding: 32px 24px; }

  /* ── Entity list ────────────────────────────────────────── */
  .entity-list { display: flex; flex-direction: column; gap: 1px; }
  .entity-list-header {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 20px;
  }
  .entity-list-header h1 {
    font-size: 32px; font-weight: 500; color: #fafafa;
    letter-spacing: -0.7px; line-height: 1.15;
  }
  .entity-list-header .count {
    font-size: 13px; font-weight: 400; color: #71717a;
  }
  .entity-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px;
    background: rgba(255,255,255,0.03);
    border-bottom: 1px solid rgba(255,255,255,0.04);
    transition: background 0.15s;
  }
  .entity-row:first-child { border-radius: 8px 8px 0 0; }
  .entity-row:last-child { border-radius: 0 0 8px 8px; border-bottom: none; }
  .entity-row:only-child { border-radius: 8px; }
  .entity-row:hover { background: rgba(255,255,255,0.05); }
  .entity-row a { flex: 1; color: #fafafa; font-size: 14px; font-weight: 500; }
  .entity-row a:hover { color: #fafafa; }
  .entity-row strong { font-weight: 500; }
  .entity-row .assignee {
    font-size: 13px; color: #71717a;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }

  /* ── Badges (lifecycle + priority) ──────────────────────── */
  .badge {
    display: inline-flex; align-items: center;
    padding: 2px 8px; border-radius: 4px;
    font-size: 12px; font-weight: 500; line-height: 1.4;
    white-space: nowrap;
  }
  .badge-pending, .badge-draft, .badge-open {
    background: rgba(245,158,11,0.15); color: #fbbf24;
  }
  .badge-in_progress, .badge-accepted {
    background: rgba(59,130,246,0.15); color: #60a5fa;
  }
  .badge-completed, .badge-implemented, .badge-resolved {
    background: rgba(34,197,94,0.15); color: #4ade80;
  }
  .badge-blocked, .badge-superseded, .badge-deferred, .badge-dead {
    background: rgba(239,68,68,0.15); color: #f87171;
  }
  .badge-high { background: rgba(239,68,68,0.15); color: #f87171; }
  .badge-medium { background: rgba(245,158,11,0.15); color: #fbbf24; }
  .badge-low { background: rgba(161,161,170,0.15); color: #a1a1aa; }

  /* ── Detail view ────────────────────────────────────────── */
  .detail-card {
    background: #18181b;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.06);
    padding: 24px;
  }
  .detail-header { margin-bottom: 24px; }
  .detail-header h1 {
    font-size: 24px; font-weight: 500; color: #fafafa;
    letter-spacing: -0.3px; line-height: 1.3;
  }
  .detail-field { margin-bottom: 16px; }
  .detail-field label {
    display: block;
    font-size: 13px; font-weight: 400; color: #a1a1aa;
    margin-bottom: 4px;
  }
  .detail-field .field-value { font-size: 16px; color: #d4d4d8; }
  .detail-field .field-value.richtext {
    line-height: 1.6; white-space: pre-wrap;
  }
  .detail-field .text-muted { color: #71717a; }

  /* ── Form inputs ────────────────────────────────────────── */
  .detail-field input, .detail-field textarea {
    width: 100%; padding: 8px 12px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 6px;
    font-size: 16px; color: #fafafa;
    font-family: inherit;
    font-feature-settings: "cv01", "ss03";
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .detail-field input::placeholder, .detail-field textarea::placeholder {
    color: #71717a;
  }
  .detail-field input:focus, .detail-field textarea:focus {
    outline: none;
    border-color: #2dd4bf;
    box-shadow: 0 0 0 2px rgba(45,212,191,0.20);
  }
  .detail-field textarea { min-height: 6rem; resize: vertical; }
  .field-dirty { border-color: #f59e0b !important; box-shadow: 0 0 0 2px rgba(245,158,11,0.15) !important; }

  /* ── Back link ──────────────────────────────────────────── */
  .back-link {
    display: inline-block; margin-bottom: 16px;
    font-size: 14px; font-weight: 500; color: #2dd4bf;
  }
  .back-link:hover { color: #5eead4; }

  /* ── Dashboard ──────────────────────────────────────────── */
  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px; margin-bottom: 24px;
  }
  .dashboard-card {
    background: rgba(255,255,255,0.03);
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.06);
    padding: 16px; text-align: center;
  }
  .dashboard-card .count {
    font-size: 32px; font-weight: 500; color: #fafafa;
    letter-spacing: -0.7px; line-height: 1.15;
  }
  .dashboard-card .label {
    font-size: 12px; font-weight: 500; color: #a1a1aa;
    margin-top: 4px; text-transform: capitalize;
    background: none; padding: 0; border-radius: 0;
  }

  /* ── Responsive ─────────────────────────────────────────── */
  @media (max-width: 640px) {
    .janus-nav { flex-wrap: wrap; height: auto; padding: 12px 16px; gap: 8px; }
    .nav-links { flex-wrap: wrap; gap: 2px; }
    .nav-link { padding: 8px 12px; font-size: 13px; }
    .janus-main { padding: 20px 16px; }
    .entity-list-header h1 { font-size: 22px; letter-spacing: -0.3px; }
    .entity-row { flex-wrap: wrap; gap: 8px; padding: 12px 16px; min-height: 44px; }
    .entity-row a { font-size: 15px; }
    .detail-card { padding: 16px; }
    .detail-header h1 { font-size: 20px; }
    .dashboard-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .dashboard-card { padding: 12px; }
    .dashboard-card .count { font-size: 24px; }
  }
`;
