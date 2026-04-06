/**
 * Schema snapshot store — persists entity schema state for reconciliation (ADR 04c).
 *
 * Uses a `_janus_schema` table (framework-internal, not an entity) to track
 * the applied schema for each entity. The reconciliation pipeline diffs the
 * desired schema against the stored snapshot.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { isSemanticField, isLifecycle, isWiringType } from '@janus/vocabulary';
import type { SemanticField } from '@janus/vocabulary';
import type { AdapterMeta } from './store-adapter';
import { sqliteType } from './schema-gen';
import type { TypeResolver } from './schema-gen';

// ── Types ───────────────────────────────────────────────────────

export interface FieldSnapshot {
  readonly name: string;
  readonly kind: string;
  readonly sqlType: string;
  readonly required: boolean;
  readonly target?: string;
  readonly enumValues?: readonly string[];
  readonly lifecycleStates?: readonly string[];
}

export interface EntitySnapshot {
  readonly entity: string;
  readonly table: string;
  readonly fields: readonly FieldSnapshot[];
  readonly version: number;
  readonly capturedAt: string;
}

export interface SchemaSnapshotStore {
  initialize(): Promise<void>;
  readSnapshot(entity: string): Promise<EntitySnapshot | null>;
  writeSnapshot(snapshot: EntitySnapshot): Promise<void>;
  readAllSnapshots(): Promise<readonly EntitySnapshot[]>;
  deleteSnapshot(entity: string): Promise<void>;
}

// ── Snapshot generation ─────────────────────────────────────────

export function generateSnapshot(meta: AdapterMeta, typeResolver: TypeResolver = sqliteType): EntitySnapshot {
  const fields: FieldSnapshot[] = [];

  for (const [name, def] of Object.entries(meta.schema)) {
    if (isSemanticField(def)) {
      fields.push({
        name,
        kind: def.kind,
        sqlType: typeResolver(def as SemanticField),
        required: !!def.hints?.required,
        enumValues: def.kind === 'enum' ? (def as { values?: readonly string[] }).values : undefined,
      });
    } else if (isLifecycle(def)) {
      fields.push({
        name,
        kind: 'lifecycle',
        sqlType: 'TEXT',
        required: false,
        lifecycleStates: Object.keys(def.transitions),
      });
    } else if (isWiringType(def)) {
      fields.push({
        name,
        kind: def.kind,
        sqlType: 'TEXT',
        required: false,
        target: (def as { target?: string }).target,
      });
    }
  }

  return {
    entity: meta.entity,
    table: meta.table,
    fields,
    version: 1,
    capturedAt: new Date().toISOString(),
  };
}

// ── SQLite implementation ───────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
export function createSchemaSnapshotStore(db: Kysely<any>): SchemaSnapshotStore {
  return {
    async initialize() {
      await sql`CREATE TABLE IF NOT EXISTS _janus_schema (
        entity TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        fields TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        captured_at TEXT NOT NULL
      )`.execute(db);
    },

    async readSnapshot(entity: string) {
      const row = await db
        .selectFrom('_janus_schema' as any)
        .where('entity', '=', entity)
        .selectAll()
        .executeTakeFirst();
      if (!row) return null;
      const r = row as Record<string, unknown>;
      return {
        entity: r.entity as string,
        table: r.table_name as string,
        fields: JSON.parse(r.fields as string) as FieldSnapshot[],
        version: r.version as number,
        capturedAt: r.captured_at as string,
      };
    },

    async writeSnapshot(snapshot: EntitySnapshot) {
      const fieldsJson = JSON.stringify(snapshot.fields);
      // Upsert
      await sql`INSERT INTO _janus_schema (entity, table_name, fields, version, captured_at)
        VALUES (${snapshot.entity}, ${snapshot.table}, ${fieldsJson}, ${snapshot.version}, ${snapshot.capturedAt})
        ON CONFLICT(entity) DO UPDATE SET
          table_name = ${snapshot.table},
          fields = ${fieldsJson},
          version = ${snapshot.version},
          captured_at = ${snapshot.capturedAt}`.execute(db);
    },

    async readAllSnapshots() {
      const rows = await db
        .selectFrom('_janus_schema' as any)
        .selectAll()
        .execute();
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          entity: r.entity as string,
          table: r.table_name as string,
          fields: JSON.parse(r.fields as string) as FieldSnapshot[],
          version: r.version as number,
          capturedAt: r.captured_at as string,
        };
      });
    },

    async deleteSnapshot(entity: string) {
      await sql`DELETE FROM _janus_schema WHERE entity = ${entity}`.execute(db);
    },
  };
}
