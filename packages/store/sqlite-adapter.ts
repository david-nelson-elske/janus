/**
 * SQLite adapter — relational store using Kysely + bun:sqlite.
 *
 * STABLE — ported from packages/next/store/sqlite-adapter.ts with unified read()
 * and simplified for M2: offset pagination only, no FTS, no cursor.
 *
 * UPDATE @ M4 (ADR 04c): Schema reconciliation — diff-based migration on restart.
 * UPDATE @ M5 (ADR 01c): FTS5 support for cross-entity search.
 */

import { Kysely, type SqliteDatabase, SqliteDialect, sql } from 'kysely';
import { isSingleton } from '@janus/vocabulary';
import type { SingletonStrategy } from '@janus/vocabulary';
import type { EntityRecord, NewEntityRecord, ReadPage, ReadParams, UpdateOptions } from '@janus/core';
import type { StoreAdapter, TransactionalAdapter, AdapterMeta, ReconcilableAdapter } from './store-adapter';
import { generateCreateTable, generateFtsTable, generateFtsTriggers, generateIndexes, tableName } from './schema-gen';
import { createSchemaSnapshotStore, generateSnapshot } from './schema-snapshot';
import type { SchemaSnapshotStore } from './schema-snapshot';
import { reconcileSchema } from './schema-reconcile';
import type { ReconciliationReport } from './schema-reconcile';
import { RelationalOps, jsonFieldNames } from './relational-ops';
import type { DialectOps } from './relational-ops';

export interface SqliteAdapterConfig {
  readonly path: string;
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
type DB = Kysely<any>;

export function createSqliteAdapter(
  config: SqliteAdapterConfig,
): ReconcilableAdapter {
  return new SqliteAdapterImpl(config);
}

// ── SQLite dialect ops ─────────────────────────────────────────

const sqliteDialect: DialectOps = {
  serializeRow(record, jsonFields) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      if (jsonFields.has(key) && value !== null) {
        result[key] = JSON.stringify(value);
      } else if (typeof value === 'object' && value !== null) {
        result[key] = JSON.stringify(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  },

  applyFtsFilter(q, tbl, search) {
    const ftsTbl = `${tbl}_fts`;
    return q.where(
      'rowid',
      'in',
      sql`(SELECT rowid FROM "${sql.raw(ftsTbl)}" WHERE "${sql.raw(ftsTbl)}" MATCH ${search})`,
    );
  },
};

// ── bun:sqlite → Kysely bridge ──────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: bun:sqlite Database type
function wrapBunSqlite(db: any): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare: (querySql: string) => {
      const stmt = db.prepare(querySql);
      return {
        reader:
          /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)/i.test(querySql) || /\bRETURNING\b/i.test(querySql),
        // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite params
        all: (params: readonly unknown[]) =>
          stmt.all(...(params as any[])) as Record<string, unknown>[],
        // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite params
        run: (params: readonly unknown[]) => {
          const { changes, lastInsertRowid } = stmt.run(...(params as any[]));
          return { changes, lastInsertRowid };
        },
        // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite params
        iterate: function* (params: readonly unknown[]) {
          for (const row of stmt.all(...(params as any[]))) yield row;
        },
      };
    },
  };
}

// ── Main adapter ────────────────────────────────────────────────

class SqliteAdapterImpl implements StoreAdapter, TransactionalAdapter {
  private db: DB;
  private metaMap = new Map<string, AdapterMeta>();
  private pendingMetas: AdapterMeta[] = [];
  private ftsEntities = new Set<string>();
  private ops: RelationalOps;
  private snapshotStore: SchemaSnapshotStore;
  private snapshotStoreReady = false;

  constructor(config: SqliteAdapterConfig) {
    const Database = require('bun:sqlite').Database;
    const database = new Database(config.path);

    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA foreign_keys = ON');

    this.db = new Kysely({
      dialect: new SqliteDialect({ database: wrapBunSqlite(database) }),
    });
    this.ops = new RelationalOps(this.db, this.metaMap, this.ftsEntities, sqliteDialect);
    this.snapshotStore = createSchemaSnapshotStore(this.db);
  }

  async initialize(meta: AdapterMeta): Promise<void> {
    this.metaMap.set(meta.entity, meta);
    this.pendingMetas.push(meta);
  }

  async finalize(drops?: ReadonlySet<string>): Promise<ReconciliationReport | null> {
    if (!this.snapshotStoreReady) {
      await this.snapshotStore.initialize();
      this.snapshotStoreReady = true;
    }

    const metas = this.pendingMetas;
    this.pendingMetas = [];

    // Single read of all snapshots — used for both reconciliation check and new-entity detection
    const existingSnapshots = await this.snapshotStore.readAllSnapshots();
    const knownEntities = new Set(existingSnapshots.map((s) => s.entity));

    // Reconcile if there are existing snapshots or drops to process
    let report: ReconciliationReport | null = null;
    if (knownEntities.size > 0 || (drops && drops.size > 0)) {
      report = await reconcileSchema(this.db, metas, this.snapshotStore, drops);
    }

    // Create tables for genuinely new entities (not in snapshot)
    for (const meta of metas) {
      if (!knownEntities.has(meta.entity)) {
        await sql.raw(generateCreateTable(meta)).execute(this.db);
        await this.snapshotStore.writeSnapshot(generateSnapshot(meta));
      }
    }

    for (const meta of metas) {
      await this.setupFtsAndIndexes(meta);
      await this.seedSingleton(meta);
    }

    return report;
  }

  private async setupFtsAndIndexes(meta: AdapterMeta): Promise<void> {
    // Create FTS5 virtual table + sync triggers (if entity has searchable fields)
    const ftsDdl = generateFtsTable(meta);
    if (ftsDdl) {
      this.ftsEntities.add(meta.entity);
      try {
        await sql.raw(ftsDdl).execute(this.db);
        const triggers = generateFtsTriggers(meta);
        if (triggers) {
          for (const trigger of triggers) {
            await sql.raw(trigger).execute(this.db);
          }
        }
      } catch {
        // FTS table may already exist — idempotent
      }
    }

    // Create declared indexes
    const indexStatements = generateIndexes(meta);
    for (const stmt of indexStatements) {
      await sql.raw(stmt).execute(this.db);
    }
  }

  private async seedSingleton(meta: AdapterMeta): Promise<void> {
    if (isSingleton(meta.storage)) {
      const tbl = tableName(meta.entity);
      const id = `_s:${meta.entity}`;
      const defaults = (meta.storage as SingletonStrategy).defaults;
      const now = new Date().toISOString();
      const jf = jsonFieldNames(meta);
      const row = sqliteDialect.serializeRow({
        id,
        _version: 1,
        createdAt: now,
        createdBy: 'system',
        updatedAt: now,
        updatedBy: 'system',
        ...defaults,
      }, jf);

      try {
        await this.db.insertInto(tbl).values(row).execute();
      } catch {
        // Already exists — skip
      }
    }
  }

  async read(meta: AdapterMeta, params?: ReadParams): Promise<EntityRecord | ReadPage> {
    return this.ops.read(meta, params);
  }

  async create(meta: AdapterMeta, record: NewEntityRecord): Promise<EntityRecord> {
    return this.ops.create(meta, record);
  }

  async update(meta: AdapterMeta, id: string, patch: Record<string, unknown>, options?: UpdateOptions): Promise<EntityRecord> {
    return this.ops.update(meta, id, patch, options);
  }

  async delete(meta: AdapterMeta, id: string): Promise<void> {
    return this.ops.delete(meta, id);
  }

  async count(meta: AdapterMeta, where: Record<string, unknown>): Promise<number> {
    return this.ops.count(meta, where);
  }

  async updateWhere(meta: AdapterMeta, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<number> {
    return this.ops.updateWhere(meta, where, patch);
  }

  async withTransaction<T>(fn: (adapter: StoreAdapter) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const txOps = new RelationalOps(trx as unknown as DB, this.metaMap, this.ftsEntities, sqliteDialect);
      const txAdapter: StoreAdapter = {
        initialize: async () => {},
        read: (meta, params) => txOps.read(meta, params),
        create: (meta, record) => txOps.create(meta, record),
        update: (meta, id, patch, options) => txOps.update(meta, id, patch, options),
        delete: (meta, id) => txOps.delete(meta, id),
        count: (meta, where) => txOps.count(meta, where),
        updateWhere: (meta, where, patch) => txOps.updateWhere(meta, where, patch),
      };
      return fn(txAdapter);
    });
  }
}
