/**
 * MemoryAdapter — in-memory StoreAdapter for testing and volatile entities.
 *
 * STABLE — ported from packages/next/store/memory-adapter.ts with unified read()
 * replacing browse()+get(). Simplified for M2: offset pagination only (no cursor).
 *
 * UPDATE @ M4 (ADR 01b): Add singleton auto-seeding in initialize().
 * UPDATE @ M5 (ADR 01c): Add full-text search support.
 */

import { isSingleton } from '@janus/vocabulary';
import type { SingletonStrategy } from '@janus/vocabulary';
import type { EntityRecord, NewEntityRecord, ReadPage, ReadParams, UpdateOptions } from '@janus/core';
import type { StoreAdapter, TransactionalAdapter, AdapterMeta } from './store-adapter';
import type { ReconciliationReport } from './schema-reconcile';
import { StoreException, entityNotFound, versionConflict } from './errors';
import type { WhereClause } from './filter';
import { matchesWhere, compareValues } from './filter';
import { useSoftDelete } from './adapter-utils';
import {
  type ResolvedTranslatableConfig,
  type TranslatableConfig,
  resolveTranslatableConfig,
  rewriteReadRecord,
  rewriteWhereClause,
  rewriteWriteRecord,
} from './translatable-helpers';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

import type { ReconcilableAdapter } from './store-adapter';

export interface MemoryAdapterConfig {
  readonly translatable?: TranslatableConfig;
}

export function createMemoryAdapter(config?: MemoryAdapterConfig): ReconcilableAdapter {
  return new MemoryAdapter(resolveTranslatableConfig(config?.translatable));
}

class MemoryAdapter implements ReconcilableAdapter {
  private tables = new Map<string, Map<string, EntityRecord>>();
  private readonly translatable: ResolvedTranslatableConfig | null;

  constructor(translatable: ResolvedTranslatableConfig | null) {
    this.translatable = translatable;
  }

  private getTable(entity: string): Map<string, EntityRecord> {
    let table = this.tables.get(entity);
    if (!table) {
      table = new Map();
      this.tables.set(entity, table);
    }
    return table;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async initialize(meta: AdapterMeta): Promise<void> {
    this.tables.set(meta.entity, new Map());

    // Seed singleton defaults
    if (isSingleton(meta.storage)) {
      const defaults = (meta.storage as SingletonStrategy).defaults;
      const id = `_s:${meta.entity}`;
      const now = new Date().toISOString();
      const record: EntityRecord = {
        id,
        _version: 1,
        createdAt: now,
        createdBy: 'system',
        updatedAt: now,
        updatedBy: 'system',
        ...defaults,
      };
      this.getTable(meta.entity).set(id, record);
    }
  }

  registerDrops(_entities: ReadonlySet<string>): void {
    // No-op for memory adapter — tables are ephemeral
  }

  async finalize(): Promise<ReconciliationReport | null> {
    return null;
  }

  // ── Read ─────────────────────────────────────────────────────

  async read(meta: AdapterMeta, params?: ReadParams): Promise<EntityRecord | ReadPage> {
    const lang = params?.lang;

    // Single record by id
    if (params?.id) {
      const record = this.getTable(meta.entity).get(params.id) ?? null;
      if (!record) throw entityNotFound(meta.entity, params.id);
      if (useSoftDelete(meta) && record._deletedAt && !params.includeDeleted) {
        throw entityNotFound(meta.entity, params.id);
      }
      return rewriteReadRecord(record, meta.schema, this.translatable, lang) as EntityRecord;
    }

    // Filtered list
    let records = Array.from(this.getTable(meta.entity).values());

    // Soft-delete filtering
    if (useSoftDelete(meta) && !params?.includeDeleted) {
      records = records.filter((r) => !r._deletedAt);
    }

    // Where clause — translatable refs rewritten to active-lang columns
    if (params?.where) {
      const where = rewriteWhereClause(
        params.where as Record<string, unknown>,
        meta.schema,
        this.translatable,
        lang,
      );
      records = records.filter((r) => matchesWhere(r, where as WhereClause));
    }

    const total = records.length;

    // Sort
    const sort = params?.sort?.length
      ? params.sort
      : [{ field: 'createdAt', direction: 'desc' as const }];
    records = [...records].sort((a, b) => {
      for (const clause of sort) {
        const result = compareValues(a[clause.field], b[clause.field], clause.direction);
        if (result !== 0) return result;
      }
      return 0;
    });

    // Offset pagination
    const limit = Math.min(params?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = params?.offset ?? 0;
    const page = records.slice(offset, offset + limit).map(
      (r) => rewriteReadRecord(r, meta.schema, this.translatable, lang) as EntityRecord,
    );
    const hasMore = offset + limit < records.length;

    return { records: page, total, hasMore, offset, limit };
  }

  // ── Write ────────────────────────────────────────────────────

  async create(meta: AdapterMeta, record: NewEntityRecord): Promise<EntityRecord> {
    // Strip the `__lang` write hint and rewrite translatable bare-field
    // values to their `<field>_<lang>` storage column when writing in a
    // non-default language.
    const { __lang: writeLang, ...rest } = record as Record<string, unknown> & { __lang?: string };
    const rewritten = rewriteWriteRecord(rest, meta.schema, this.translatable, writeLang);

    const now = new Date().toISOString();
    const full: EntityRecord = {
      ...rewritten,
      id: (rewritten.id as string | undefined) ?? crypto.randomUUID(),
      _version: 1,
      createdAt: now,
      createdBy: (rewritten.createdBy as string) ?? 'system',
      updatedAt: now,
      updatedBy: (rewritten.updatedBy as string) ?? 'system',
    };
    const table = this.getTable(meta.entity);
    if (table.has(full.id)) {
      throw new StoreException({ kind: 'conflict', entity: meta.entity, id: full.id });
    }
    table.set(full.id, full);
    return full;
  }

  async update(
    meta: AdapterMeta,
    id: string,
    patch: Record<string, unknown>,
    options?: UpdateOptions,
  ): Promise<EntityRecord> {
    const table = this.getTable(meta.entity);
    const existing = table.get(id);
    if (!existing) throw entityNotFound(meta.entity, id);
    if (useSoftDelete(meta) && existing._deletedAt) throw entityNotFound(meta.entity, id);

    if (options?.expectedVersion !== undefined && existing._version !== options.expectedVersion) {
      throw versionConflict(meta.entity, id, options.expectedVersion, existing._version);
    }

    const rewritten = rewriteWriteRecord(patch, meta.schema, this.translatable, options?.lang);

    const updated: EntityRecord = {
      ...existing,
      ...rewritten,
      id: existing.id,
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      _version: existing._version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: (rewritten.updatedBy as string) ?? existing.updatedBy,
    };
    table.set(id, updated);
    return updated;
  }

  async delete(meta: AdapterMeta, id: string): Promise<void> {
    const table = this.getTable(meta.entity);
    const existing = table.get(id);
    if (!existing) throw entityNotFound(meta.entity, id);

    if (useSoftDelete(meta)) {
      table.set(id, { ...existing, _deletedAt: new Date().toISOString() });
    } else {
      table.delete(id);
    }
  }

  // ── Count & bulk update (ADR 01d) ─────────────────────────────

  async count(meta: AdapterMeta, where: Record<string, unknown>): Promise<number> {
    let records = Array.from(this.getTable(meta.entity).values());
    if (useSoftDelete(meta)) {
      records = records.filter((r) => !r._deletedAt);
    }
    records = records.filter((r) => matchesWhere(r, where as WhereClause));
    return records.length;
  }

  async updateWhere(meta: AdapterMeta, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<number> {
    const table = this.getTable(meta.entity);
    let records = Array.from(table.values());
    if (useSoftDelete(meta)) {
      records = records.filter((r) => !r._deletedAt);
    }
    records = records.filter((r) => matchesWhere(r, where as WhereClause));
    const now = new Date().toISOString();
    for (const record of records) {
      table.set(record.id, {
        ...record,
        ...patch,
        id: record.id,
        createdAt: record.createdAt,
        createdBy: record.createdBy,
        _version: record._version + 1,
        updatedAt: now,
      });
    }
    return records.length;
  }

  // ── Transactions (snapshot/restore) ──────────────────────────

  async withTransaction<T>(fn: (adapter: StoreAdapter) => Promise<T>): Promise<T> {
    const snapshot = new Map<string, Map<string, EntityRecord>>();
    for (const [name, table] of this.tables) {
      snapshot.set(name, new Map(table));
    }
    try {
      return await fn(this);
    } catch (e) {
      this.tables = snapshot;
      throw e;
    }
  }
}

// useSoftDelete imported from adapter-utils.ts
