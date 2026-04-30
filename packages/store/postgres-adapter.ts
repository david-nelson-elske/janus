/**
 * Postgres adapter — relational store using Kysely + postgres-js.
 *
 * Parallel to sqlite-adapter.ts with Postgres-specific:
 * - PostgresJSDialect instead of SqliteDialect
 * - Native BOOLEAN, TIMESTAMPTZ, JSONB types
 * - tsvector + GIN for full-text search (replaces FTS5)
 * - Connection pool instead of file path
 */

import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres from 'postgres';
import { isSingleton } from '@janus/vocabulary';
import type { SingletonStrategy } from '@janus/vocabulary';
import type { EntityRecord, NewEntityRecord, ReadPage, ReadParams, UpdateOptions } from '@janus/core';
import type { StoreAdapter, TransactionalAdapter, AdapterMeta, ReconcilableAdapter } from './store-adapter';
import {
  generateCreateTablePg,
  generatePgFtsSetup,
  generateIndexes,
  tableName,
  postgresType,
} from './schema-gen';
import { createSchemaSnapshotStore, generateSnapshot } from './schema-snapshot';
import type { SchemaSnapshotStore } from './schema-snapshot';
import { reconcileSchema } from './schema-reconcile';
import type { ReconciliationReport } from './schema-reconcile';
import { RelationalOps, jsonFieldNames } from './relational-ops';
import type { DialectOps } from './relational-ops';
import {
  type ResolvedTranslatableConfig,
  type TranslatableConfig,
  resolveTranslatableConfig,
} from './translatable-helpers';

export interface PostgresAdapterConfig {
  /** Connection URL (e.g., postgres://user:pass@localhost:5432/db). */
  readonly url?: string;
  /** Host (default: localhost). Ignored if url is provided. */
  readonly host?: string;
  /** Port (default: 5432). Ignored if url is provided. */
  readonly port?: number;
  /** Database name. Ignored if url is provided. */
  readonly database?: string;
  /** User. Ignored if url is provided. */
  readonly user?: string;
  /** Password. Ignored if url is provided. */
  readonly password?: string;
  /** Max connections in pool (default: 10). */
  readonly max?: number;
  /** Translatable field config (ADR 125-00). Provisions parallel `<field>_<lang>` columns. */
  readonly translatable?: TranslatableConfig;
}

// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
type DB = Kysely<any>;

export function createPostgresAdapter(config: PostgresAdapterConfig): ReconcilableAdapter & { destroy(): Promise<void> } {
  return new PostgresAdapterImpl(config);
}

// ── Postgres dialect ops ───────────────────────────────────────

const postgresDialect: DialectOps = {
  serializeRow(record, jsonFields) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      if (jsonFields.has(key)) {
        // JSONB columns: pass objects directly, postgres-js handles serialization
        result[key] = value;
      } else if (typeof value === 'object' && value !== null) {
        // Non-JSONB columns with object values: stringify for TEXT storage
        result[key] = JSON.stringify(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  },

  applyFtsFilter(q, _tbl, search) {
    return q.where(sql<boolean>`"_tsv" @@ plainto_tsquery('english', ${search})`);
  },
};

// ── Main adapter ────────────────────────────────────────────────

class PostgresAdapterImpl implements ReconcilableAdapter {
  private db: DB;
  private pgSql: ReturnType<typeof postgres>;
  private metaMap = new Map<string, AdapterMeta>();
  private pendingMetas: AdapterMeta[] = [];
  private ftsEntities = new Set<string>();
  private ops: RelationalOps;
  private snapshotStore: SchemaSnapshotStore;
  private snapshotStoreReady = false;
  private translatable: ResolvedTranslatableConfig | null;

  constructor(config: PostgresAdapterConfig) {
    const pgOptions: postgres.Options<Record<string, postgres.PostgresType>> = {
      max: config.max ?? 10,
    };

    if (config.url) {
      this.pgSql = postgres(config.url, pgOptions);
    } else {
      this.pgSql = postgres({
        ...pgOptions,
        host: config.host ?? 'localhost',
        port: config.port ?? 5432,
        database: config.database,
        user: config.user,
        password: config.password,
      });
    }

    this.db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: this.pgSql }),
    });
    this.translatable = resolveTranslatableConfig(config.translatable);
    this.ops = new RelationalOps(
      this.db,
      this.metaMap,
      this.ftsEntities,
      postgresDialect,
      this.translatable,
    );
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

    const existingSnapshots = await this.snapshotStore.readAllSnapshots();
    const knownEntities = new Set(existingSnapshots.map((s) => s.entity));

    // Reconcile if there are existing snapshots or drops to process
    let report: ReconciliationReport | null = null;
    if (knownEntities.size > 0 || (drops && drops.size > 0)) {
      report = await reconcileSchema(this.db, metas, this.snapshotStore, drops, this.translatable);
    }

    // Create tables for genuinely new entities (not in snapshot)
    for (const meta of metas) {
      if (!knownEntities.has(meta.entity)) {
        await sql.raw(generateCreateTablePg(meta, this.translatable)).execute(this.db);
        await this.snapshotStore.writeSnapshot(
          generateSnapshot(meta, postgresType, this.translatable),
        );
      }
    }

    for (const meta of metas) {
      await this.setupFtsAndIndexes(meta);
      await this.seedSingleton(meta);
    }

    return report;
  }

  private async setupFtsAndIndexes(meta: AdapterMeta): Promise<void> {
    // Create Postgres FTS: tsvector column, GIN index, trigger
    const ftsSetup = generatePgFtsSetup(meta);
    if (ftsSetup) {
      this.ftsEntities.add(meta.entity);
      try {
        await sql.raw(ftsSetup.index).execute(this.db);
        await sql.raw(ftsSetup.triggerFn).execute(this.db);
        await sql.raw(ftsSetup.trigger).execute(this.db);
      } catch {
        // May already exist — idempotent
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
      const row = postgresDialect.serializeRow({
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
      const txOps = new RelationalOps(
        trx as unknown as DB,
        this.metaMap,
        this.ftsEntities,
        postgresDialect,
        this.translatable,
      );
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

  async destroy(): Promise<void> {
    await this.db.destroy();
    await this.pgSql.end();
  }
}
