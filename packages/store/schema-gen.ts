/**
 * Schema generation for SQLite — converts entity schemas to DDL.
 *
 * STABLE — ported from packages/next/store/schema-gen.ts with simplified tableName()
 * (no realm prefix — origin is tracked on the entity, not in the table name).
 *
 * UPDATE @ M4 (ADR 04c): Full schema reconciliation (safe/cautious/destructive/ambiguous
 * classification, evolve config, production plan/apply workflow). Currently only the safe
 * tier is implemented: ALTER TABLE ADD COLUMN for new nullable fields.
 */

import { isSemanticField, isLifecycle, isWiringType } from '@janus/vocabulary';
import type { SemanticField } from '@janus/vocabulary';
import type { AdapterMeta } from './store-adapter';

// ── Type mapping ────────────────────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  str: 'TEXT',
  int: 'INTEGER',
  float: 'REAL',
  bool: 'INTEGER',
  datetime: 'TEXT',
  enum: 'TEXT',
  json: 'TEXT',
  intCents: 'INTEGER',
  intBps: 'INTEGER',
  markdown: 'TEXT',
  email: 'TEXT',
  url: 'TEXT',
  phone: 'TEXT',
  slug: 'TEXT',
  color: 'TEXT',
  icon: 'TEXT',
  asset: 'TEXT',
  id: 'TEXT',
  token: 'TEXT',
  scope: 'TEXT',
  duration: 'INTEGER',
  cron: 'TEXT',
  template: 'TEXT',
  latLng: 'TEXT',
  availability: 'TEXT',
  recurrence: 'TEXT',
  qrCode: 'TEXT',
};

export function sqliteType(field: SemanticField): string {
  return TYPE_MAP[field.kind] ?? 'TEXT';
}

// ── Postgres type mapping ──────────────────────────────────────

const PG_TYPE_MAP: Record<string, string> = {
  str: 'TEXT',
  int: 'INTEGER',
  float: 'DOUBLE PRECISION',
  bool: 'BOOLEAN',
  datetime: 'TIMESTAMPTZ',
  enum: 'TEXT',
  json: 'JSONB',
  intCents: 'INTEGER',
  intBps: 'INTEGER',
  markdown: 'TEXT',
  email: 'TEXT',
  url: 'TEXT',
  phone: 'TEXT',
  slug: 'TEXT',
  color: 'TEXT',
  icon: 'TEXT',
  asset: 'TEXT',
  id: 'TEXT',
  token: 'TEXT',
  scope: 'TEXT',
  duration: 'INTEGER',
  cron: 'TEXT',
  template: 'TEXT',
  latLng: 'TEXT',
  availability: 'TEXT',
  recurrence: 'TEXT',
  qrCode: 'TEXT',
};

export function postgresType(field: SemanticField): string {
  return PG_TYPE_MAP[field.kind] ?? 'TEXT';
}

/** Generic type resolver — allows adapters to plug in their dialect's type map. */
export type TypeResolver = (field: SemanticField) => string;

// ── Table name ──────────────────────────────────────────────────

/**
 * Entity name → SQL table name. Entity names already use underscores
 * and are directly usable as table names.
 */
export function tableName(entityName: string): string {
  return entityName;
}

// ── DDL generation ──────────────────────────────────────────────

export function generateCreateTable(meta: AdapterMeta): string {
  const tbl = tableName(meta.entity);
  const columns: string[] = [
    'id TEXT PRIMARY KEY',
    '_version INTEGER NOT NULL DEFAULT 1',
    'createdAt TEXT NOT NULL',
    'createdBy TEXT NOT NULL',
    'updatedAt TEXT NOT NULL',
    'updatedBy TEXT NOT NULL',
    '_deletedAt TEXT',
  ];

  for (const [name, def] of Object.entries(meta.schema)) {
    const quoted = `"${name}"`;
    if (isLifecycle(def)) {
      columns.push(`${quoted} TEXT`);
    } else if (isWiringType(def)) {
      // Relation/Reference/Mention fields store an ID (text)
      columns.push(`${quoted} TEXT`);
    } else if (isSemanticField(def)) {
      const type = sqliteType(def);
      const notNull = def.hints?.required ? ' NOT NULL' : '';
      columns.push(`${quoted} ${type}${notNull}`);
    }
  }

  return `CREATE TABLE IF NOT EXISTS "${tbl}" (\n  ${columns.join(',\n  ')}\n)`;
}

// ── FTS5 (full-text search) ──────────────────────────────────────

/** Semantic type kinds that are searchable by default. */
const SEARCHABLE_KINDS = new Set(['str', 'markdown', 'email']);

/**
 * Get searchable field names from an entity schema.
 * A field is searchable if it's a Str, Markdown, or Email type
 * and not explicitly marked searchable: false.
 */
export function getSearchableFields(meta: AdapterMeta): string[] {
  const fields: string[] = [];
  for (const [name, def] of Object.entries(meta.schema)) {
    if (isSemanticField(def) && SEARCHABLE_KINDS.has(def.kind)) {
      const searchable = (def as { hints?: { searchable?: boolean } }).hints?.searchable;
      if (searchable !== false) {
        fields.push(name);
      }
    }
  }
  return fields;
}

/**
 * Generate FTS5 virtual table DDL.
 * Returns null if the entity has no searchable fields.
 */
export function generateFtsTable(meta: AdapterMeta): string | null {
  const tbl = tableName(meta.entity);
  const searchableFields = getSearchableFields(meta);
  if (searchableFields.length === 0) return null;

  return `CREATE VIRTUAL TABLE IF NOT EXISTS "${tbl}_fts" USING fts5(${searchableFields.join(', ')}, content="${tbl}", content_rowid=rowid)`;
}

/**
 * Generate FTS5 sync triggers (INSERT/UPDATE/DELETE).
 * Returns null if the entity has no searchable fields.
 */
export function generateFtsTriggers(meta: AdapterMeta): string[] | null {
  const tbl = tableName(meta.entity);
  const ftsFields = getSearchableFields(meta);
  if (ftsFields.length === 0) return null;

  const newCols = ftsFields.map((f) => `new."${f}"`).join(', ');
  const oldCols = ftsFields.map((f) => `old."${f}"`).join(', ');
  const fieldList = ftsFields.map((f) => `"${f}"`).join(', ');

  return [
    `CREATE TRIGGER IF NOT EXISTS "${tbl}_ai" AFTER INSERT ON "${tbl}" BEGIN INSERT INTO "${tbl}_fts"(rowid, ${fieldList}) VALUES (new.rowid, ${newCols}); END`,
    `CREATE TRIGGER IF NOT EXISTS "${tbl}_ad" AFTER DELETE ON "${tbl}" BEGIN INSERT INTO "${tbl}_fts"("${tbl}_fts", rowid, ${fieldList}) VALUES ('delete', old.rowid, ${oldCols}); END`,
    `CREATE TRIGGER IF NOT EXISTS "${tbl}_au" AFTER UPDATE ON "${tbl}" BEGIN INSERT INTO "${tbl}_fts"("${tbl}_fts", rowid, ${fieldList}) VALUES ('delete', old.rowid, ${oldCols}); INSERT INTO "${tbl}_fts"(rowid, ${fieldList}) VALUES (new.rowid, ${newCols}); END`,
  ];
}

// ── Postgres DDL generation ─────────────────────────────────────

export function generateCreateTablePg(meta: AdapterMeta): string {
  const tbl = tableName(meta.entity);
  const columns: string[] = [
    'id TEXT PRIMARY KEY',
    '_version INTEGER NOT NULL DEFAULT 1',
    'createdAt TIMESTAMPTZ NOT NULL',
    'createdBy TEXT NOT NULL',
    'updatedAt TIMESTAMPTZ NOT NULL',
    'updatedBy TEXT NOT NULL',
    '_deletedAt TIMESTAMPTZ',
  ];

  const searchableFields = getSearchableFields(meta);

  for (const [name, def] of Object.entries(meta.schema)) {
    const quoted = `"${name}"`;
    if (isLifecycle(def)) {
      columns.push(`${quoted} TEXT`);
    } else if (isWiringType(def)) {
      columns.push(`${quoted} TEXT`);
    } else if (isSemanticField(def)) {
      const type = postgresType(def);
      const notNull = def.hints?.required ? ' NOT NULL' : '';
      columns.push(`${quoted} ${type}${notNull}`);
    }
  }

  // Add tsvector column for FTS if entity has searchable fields
  if (searchableFields.length > 0) {
    columns.push('_tsv tsvector');
  }

  return `CREATE TABLE IF NOT EXISTS "${tbl}" (\n  ${columns.join(',\n  ')}\n)`;
}

// ── Postgres FTS (tsvector + GIN) ───────────────────────────────

export interface PgFtsSetup {
  readonly index: string;
  readonly triggerFn: string;
  readonly trigger: string;
}

/**
 * Generate Postgres FTS setup: GIN index + trigger function + trigger.
 * Returns null if the entity has no searchable fields.
 */
export function generatePgFtsSetup(meta: AdapterMeta): PgFtsSetup | null {
  const tbl = tableName(meta.entity);
  const searchableFields = getSearchableFields(meta);
  if (searchableFields.length === 0) return null;

  const index = `CREATE INDEX IF NOT EXISTS "${tbl}_tsv_idx" ON "${tbl}" USING gin(_tsv)`;

  // Build tsvector expression: to_tsvector('english', coalesce(field1,'') || ' ' || ...)
  const parts = searchableFields.map((f) => `coalesce(NEW."${f}", '')`).join(` || ' ' || `);
  const fnName = `${tbl}_tsv_update`;

  const triggerFn = [
    `CREATE OR REPLACE FUNCTION "${fnName}"() RETURNS trigger AS $$`,
    `BEGIN`,
    `  NEW._tsv := to_tsvector('english', ${parts});`,
    `  RETURN NEW;`,
    `END`,
    `$$ LANGUAGE plpgsql`,
  ].join('\n');

  const trigger = `CREATE OR REPLACE TRIGGER "${tbl}_tsv_trigger" BEFORE INSERT OR UPDATE ON "${tbl}" FOR EACH ROW EXECUTE FUNCTION "${fnName}"()`;

  return { index, triggerFn, trigger };
}

// ── Index generation ────────────────────────────────────────────

/**
 * Generate CREATE INDEX DDL for an entity's declared indexes.
 */
export function generateIndexes(meta: AdapterMeta): string[] {
  if (!meta.indexes || meta.indexes.length === 0) return [];
  const tbl = tableName(meta.entity);
  const statements: string[] = [];
  for (const idx of meta.indexes) {
    const name = idx.name ?? `idx_${meta.entity}_${idx.fields.join('_')}`;
    const unique = idx.unique ? 'UNIQUE ' : '';
    const cols = idx.fields.map((f) => `"${f}"`).join(', ');
    statements.push(`CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${tbl}" (${cols})`);
  }
  return statements;
}

// ── Schema diff (safe tier of ADR 04c) ──────────────────────────

/** Column info returned by PRAGMA table_info */
export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

/** Result of comparing compiled schema to existing table */
export interface SchemaDiff {
  /** New columns to add (safe — ALTER TABLE ADD COLUMN) */
  readonly additions: readonly { name: string; sql: string }[];
  /** Columns in DB but not in schema (warning only — no auto-drop) */
  readonly removals: readonly string[];
  /** Whether any changes were detected */
  readonly hasChanges: boolean;
}

/** Framework-managed columns that always exist and should not be diffed */
const FRAMEWORK_COLUMNS = new Set(['id', '_version', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', '_deletedAt']);

/**
 * Compare compiled entity schema against existing table columns.
 * Returns ALTER TABLE ADD COLUMN statements for new fields.
 * Removals are reported but not applied (destructive).
 */
export function diffSchema(meta: AdapterMeta, existingColumns: readonly ColumnInfo[]): SchemaDiff {
  const tbl = tableName(meta.entity);
  const existing = new Set(existingColumns.map((c) => c.name));
  const additions: { name: string; sql: string }[] = [];
  const removals: string[] = [];

  // Find new columns in schema that don't exist in the table
  for (const [name, def] of Object.entries(meta.schema)) {
    if (existing.has(name)) continue;

    if (isLifecycle(def)) {
      additions.push({ name, sql: `ALTER TABLE "${tbl}" ADD COLUMN "${name}" TEXT` });
    } else if (isWiringType(def)) {
      additions.push({ name, sql: `ALTER TABLE "${tbl}" ADD COLUMN "${name}" TEXT` });
    } else if (isSemanticField(def)) {
      const type = sqliteType(def);
      // Note: ALTER TABLE ADD COLUMN cannot have NOT NULL without a DEFAULT in SQLite.
      // New required columns are added as nullable; the framework validates at the pipeline level.
      additions.push({ name, sql: `ALTER TABLE "${tbl}" ADD COLUMN "${name}" ${type}` });
    }
  }

  // Find columns in table that don't exist in schema (excluding framework columns)
  const schemaFields = new Set(Object.keys(meta.schema));
  for (const col of existingColumns) {
    if (FRAMEWORK_COLUMNS.has(col.name)) continue;
    if (!schemaFields.has(col.name)) {
      removals.push(col.name);
    }
  }

  return {
    additions,
    removals,
    hasChanges: additions.length > 0 || removals.length > 0,
  };
}
