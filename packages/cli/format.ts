/**
 * Output formatters — JSON for agents, table for humans.
 */

import type { CapabilityRecord } from '@janus/core';
import { isSemanticField } from '@janus/vocabulary';

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function formatTable(records: readonly Record<string, unknown>[], fields?: string[]): string {
  if (records.length === 0) return '(no records)';

  // Determine columns
  const columns = fields ?? deriveColumns(records);
  if (columns.length === 0) return '(no fields)';

  // Calculate column widths
  const widths = columns.map((col) => {
    const values = records.map((r) => formatCell(r[col]));
    return Math.max(col.length, ...values.map((v) => v.length));
  });

  // Cap column widths
  const maxWidth = 40;
  const cappedWidths = widths.map((w) => Math.min(w, maxWidth));

  // Header
  const header = columns.map((col, i) => col.padEnd(cappedWidths[i])).join('  ');
  const separator = cappedWidths.map((w) => '─'.repeat(w)).join('──');

  // Rows
  const rows = records.map((record) =>
    columns
      .map((col, i) => truncate(formatCell(record[col]), cappedWidths[i]).padEnd(cappedWidths[i]))
      .join('  '),
  );

  return [header, separator, ...rows].join('\n');
}

export function formatRecord(record: Record<string, unknown>, fields?: string[]): string {
  const keys = fields ?? Object.keys(record).filter((k) => !k.startsWith('_'));
  const maxKeyLen = Math.max(...keys.map((k) => k.length));

  return keys
    .map((key) => `${key.padEnd(maxKeyLen)}  ${formatCell(record[key])}`)
    .join('\n');
}

export function formatOperations(operations: readonly string[], transitions: readonly string[], entity: string): string {
  const lines = [`Operations for ${entity}:`, ''];
  for (const op of operations) {
    lines.push(`  ${op}`);
  }
  if (transitions.length > 0) {
    lines.push('', 'Lifecycle transitions:');
    for (const t of transitions) {
      lines.push(`  ${t}`);
    }
  }
  return lines.join('\n');
}

export function formatFields(schema: Record<string, unknown>, entity: string): string {
  const lines = [`Fields for ${entity}:`, ''];
  for (const [name, def] of Object.entries(schema)) {
    const kind = (def as { kind?: string })?.kind ?? 'unknown';
    const required = (def as { hints?: { required?: boolean } })?.hints?.required ? ' (required)' : '';
    lines.push(`  ${name.padEnd(20)} ${kind}${required}`);
  }
  return lines.join('\n');
}

export function formatEntities(entities: string[]): string {
  if (entities.length === 0) return '(no entities)';
  return ['Entities:', '', ...entities.map((e) => `  ${e}`)].join('\n');
}

// ── Capability formatters ──────────────────────────────────────

export function formatCapabilities(caps: readonly CapabilityRecord[]): string {
  if (caps.length === 0) return '(no capabilities)';

  // Group by namespace (text before first '__') for readable scanning.
  const groups = new Map<string, CapabilityRecord[]>();
  for (const cap of caps) {
    const idx = cap.name.indexOf('__');
    const ns = idx === -1 ? cap.name : cap.name.slice(0, idx);
    let list = groups.get(ns);
    if (!list) {
      list = [];
      groups.set(ns, list);
    }
    list.push(cap);
  }

  const lines: string[] = ['Capabilities:', ''];
  for (const [ns, list] of groups) {
    lines.push(`  ${ns}:`);
    for (const cap of list) {
      const audit = cap.audit ? ' [audited]' : '';
      lines.push(`    ${cap.name.padEnd(32)} ${cap.description}${audit}`);
    }
  }
  return lines.join('\n');
}

export function formatCapability(cap: CapabilityRecord): string {
  const lines: string[] = [
    `${cap.name}`,
    '─'.repeat(cap.name.length),
    cap.description,
  ];
  if (cap.longDescription) {
    lines.push('', cap.longDescription);
  }
  lines.push('', 'Input fields:');
  for (const [name, def] of Object.entries(cap.inputSchema)) {
    const kind = isSemanticField(def) ? def.kind : 'unknown';
    const required = isSemanticField(def) && def.hints?.required ? ' (required)' : '';
    const enumValues =
      isSemanticField(def) && def.kind === 'enum'
        ? ` ∈ {${(def as unknown as { values: readonly string[] }).values.join(', ')}}`
        : '';
    lines.push(`  ${name.padEnd(20)} ${kind}${required}${enumValues}`);
  }
  if (cap.outputSchema) {
    lines.push('', 'Output fields:');
    for (const [name, def] of Object.entries(cap.outputSchema)) {
      const kind = isSemanticField(def) ? def.kind : 'unknown';
      lines.push(`  ${name.padEnd(20)} ${kind}`);
    }
  }
  if (cap.tags?.length) {
    lines.push('', `Tags: ${cap.tags.join(', ')}`);
  }
  const settings: string[] = [];
  if (cap.audit) settings.push('audited');
  if (cap.auditRedact?.length) settings.push(`redacts: ${cap.auditRedact.join(', ')}`);
  if (cap.policy) settings.push('policy enforced');
  if (cap.rateLimit) settings.push(`rate-limited (${cap.rateLimit.max}/${cap.rateLimit.window}ms)`);
  if (settings.length) {
    lines.push('', `Settings: ${settings.join(' · ')}`);
  }
  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

/** Derive column list from records, excluding internal fields. */
function deriveColumns(records: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      seen.add(key);
    }
  }
  // Put id first, then sort remaining, exclude internal fields
  const cols = [...seen].filter((k) => !k.startsWith('_') && k !== 'id');
  cols.sort();
  if (seen.has('id')) cols.unshift('id');
  return cols;
}
