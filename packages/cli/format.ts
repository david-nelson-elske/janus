/**
 * Output formatters — JSON for agents, table for humans.
 */

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
