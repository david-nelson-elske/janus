/**
 * Template engine — LiquidJS rendering with semantic type filters (ADR 10b).
 *
 * Two-tier rendering:
 * - Tier 1: Schema-derived (auto-generate from entity schema, no template needed)
 * - Tier 2: Named template (resolve by name, render with LiquidJS)
 *
 * Semantic type filters map 1:1 with vocabulary types.
 */

import { Liquid } from 'liquidjs';
import type { GraphNodeRecord, EntityRecord } from '@janus/core';
import { isSemanticField, isLifecycle } from '@janus/vocabulary';

// ── Types ───────────────────────────────────────────────────────

export interface RenderOptions {
  /** Liquid template source string. */
  readonly template: string;
  /** Data context for template variables. */
  readonly data: Record<string, unknown>;
  /** Optional layout template source (child body injected as {{ content }}). */
  readonly layout?: string;
  /** Static context merged into render data. */
  readonly context?: Record<string, unknown>;
}

export interface RenderResult {
  readonly subject?: string;
  readonly body: string;
  readonly format: 'html' | 'markdown' | 'text';
}

export interface TemplateWarning {
  readonly templateName: string;
  readonly entity: string;
  readonly unknownVariables: readonly string[];
}

// ── Semantic type filters ───────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatDateTime(v: unknown, format?: string): string {
  if (!v) return '';
  const d = new Date(v as string | number);
  if (Number.isNaN(d.getTime())) return String(v);
  switch (format) {
    case 'short': return d.toLocaleDateString();
    case 'long': return d.toLocaleString();
    case 'iso': return d.toISOString();
    case 'relative': {
      const diff = Date.now() - d.getTime();
      if (diff < 60_000) return 'just now';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return `${Math.floor(diff / 86_400_000)}d ago`;
    }
    default: return d.toISOString();
  }
}

function registerFilters(engine: Liquid): void {
  engine.registerFilter('cents', (v: unknown) => {
    const n = Number(v);
    return Number.isNaN(n) ? String(v) : `$${(n / 100).toFixed(2)}`;
  });

  engine.registerFilter('bps', (v: unknown) => {
    const n = Number(v);
    return Number.isNaN(n) ? String(v) : `${(n / 100).toFixed(2)}%`;
  });

  engine.registerFilter('datetime', (v: unknown, format?: string) => formatDateTime(v, format));

  engine.registerFilter('duration', (v: unknown) => {
    const n = Number(v);
    return Number.isNaN(n) ? String(v) : formatDuration(n);
  });

  engine.registerFilter('yesno', (v: unknown, yes?: string, no?: string) =>
    v ? (yes ?? 'Yes') : (no ?? 'No'),
  );

  engine.registerFilter('number', (v: unknown) => {
    const n = Number(v);
    return Number.isNaN(n) ? String(v) : n.toLocaleString();
  });

  engine.registerFilter('asset_url', (v: unknown) => String(v));

  engine.registerFilter('token', (v: unknown) => {
    const s = String(v);
    if (s.length <= 8) return s;
    return `${s.slice(0, 4)}...${s.slice(-4)}`;
  });
}

// ── Engine creation ─────────────────────────────────────────────

let _engine: Liquid | null = null;

function getEngine(): Liquid {
  if (!_engine) {
    _engine = new Liquid({ strictVariables: false });
    registerFilters(_engine);
  }
  return _engine;
}

// ── Tier 2: Named template rendering ────────────────────────────

export async function renderTemplate(options: RenderOptions): Promise<string> {
  const engine = getEngine();
  const data = { ...options.context, ...options.data };

  const bodyResult = await engine.parseAndRender(options.template, data);

  if (options.layout) {
    return engine.parseAndRender(options.layout, { ...data, content: bodyResult });
  }

  return bodyResult;
}

// ── Tier 1: Schema-derived rendering ────────────────────────────

export function renderFromSchema(
  entity: GraphNodeRecord,
  record: EntityRecord,
  format: 'html' | 'markdown' | 'text' = 'text',
): RenderResult {
  const lines: string[] = [];
  const subject = `${entity.name}: ${record.id}`;

  for (const [field, def] of Object.entries(entity.schema)) {
    const value = record[field];
    if (value === null || value === undefined) continue;

    let formatted: string;
    if (isSemanticField(def)) {
      switch (def.kind) {
        case 'intcents': formatted = `$${(Number(value) / 100).toFixed(2)}`; break;
        case 'intbps': formatted = `${(Number(value) / 100).toFixed(2)}%`; break;
        case 'datetime': formatted = formatDateTime(value, 'long'); break;
        case 'duration': formatted = formatDuration(Number(value)); break;
        case 'bool': formatted = value ? 'Yes' : 'No'; break;
        case 'token': {
          const s = String(value);
          formatted = s.length > 8 ? `${s.slice(0, 4)}...${s.slice(-4)}` : s;
          break;
        }
        default: formatted = String(value);
      }
    } else if (isLifecycle(def)) {
      formatted = String(value);
    } else {
      formatted = String(value);
    }

    if (format === 'markdown') {
      lines.push(`**${field}:** ${formatted}`);
    } else if (format === 'html') {
      lines.push(`<dt>${field}</dt><dd>${formatted}</dd>`);
    } else {
      lines.push(`${field}: ${formatted}`);
    }
  }

  let body: string;
  if (format === 'html') {
    body = `<dl>${lines.join('')}</dl>`;
  } else {
    body = lines.join('\n');
  }

  return { subject, body, format };
}

// ── Template variable validation ────────────────────────────────

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)/g;

export function validateTemplateVariables(
  source: string,
  schemaFields: readonly string[],
): string[] {
  const fieldSet = new Set(schemaFields);
  // Also allow common framework fields
  fieldSet.add('id');
  fieldSet.add('createdAt');
  fieldSet.add('createdBy');
  fieldSet.add('updatedAt');
  fieldSet.add('updatedBy');

  const unknowns: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_PATTERN.exec(source)) !== null) {
    const varName = match[1].split('.')[0]; // handle nested access like record.title
    if (!fieldSet.has(varName)) {
      unknowns.push(varName);
    }
  }

  return [...new Set(unknowns)];
}
