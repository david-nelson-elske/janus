/**
 * Shared relational CRUD operations for Kysely-based adapters.
 *
 * Both SQLite and Postgres adapters delegate all CRUD to this class.
 * Dialect-specific behavior (JSON serialization, FTS queries) is injected
 * via the DialectOps interface.
 */

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { isSemanticField } from '@janus/vocabulary';
import type { EntityRecord, NewEntityRecord, ReadPage, ReadParams, UpdateOptions } from '@janus/core';
import type { AdapterMeta } from './store-adapter';
import type { WhereClause } from './filter';
import { entityNotFound, versionConflict } from './errors';
import { tableName } from './schema-gen';
import { useSoftDelete } from './adapter-utils';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// biome-ignore lint/suspicious/noExplicitAny: Kysely generic DB type
type DB = Kysely<any>;

// ── Dialect injection ──────────────────────────────────────────

export interface DialectOps {
  /** Serialize a record for insertion/update. Handles JSON field encoding. */
  serializeRow(record: Record<string, unknown>, jsonFields: Set<string>): Record<string, unknown>;
  /** Apply FTS filter to a Kysely query. Called only when entity has FTS and search param is present. */
  // biome-ignore lint/suspicious/noExplicitAny: generic Kysely query builder
  applyFtsFilter(q: any, tbl: string, search: string): any;
}

// ── Shared utilities ───────────────────────────────────────────

/** Detect JSON-typed fields in an entity schema. */
export function jsonFieldNames(meta: AdapterMeta): Set<string> {
  const fields = new Set<string>();
  for (const [name, def] of Object.entries(meta.schema)) {
    if (isSemanticField(def) && def.kind === 'json') {
      fields.add(name);
    }
  }
  return fields;
}

/**
 * Deserialize a record from the database.
 * Attempts JSON.parse on string values in JSON-typed fields.
 * Works for both SQLite (strings) and Postgres (objects pass through).
 */
export function deserializeRow(
  record: Record<string, unknown>,
  jsonFields: Set<string>,
): EntityRecord {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (jsonFields.has(key) && typeof value === 'string') {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result as EntityRecord;
}

// ── WHERE clause application ────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: generic Kysely query builder
export function applyWhereClause(q: any, where: WhereClause): any {
  let result = q;
  for (const [field, value] of Object.entries(where)) {
    if (value === null || value === undefined) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      const filter = value as Record<string, unknown>;
      for (const [op, operand] of Object.entries(filter)) {
        switch (op) {
          case '$gt':
            result = result.where(field, '>', operand);
            break;
          case '$gte':
            result = result.where(field, '>=', operand);
            break;
          case '$lt':
            result = result.where(field, '<', operand);
            break;
          case '$lte':
            result = result.where(field, '<=', operand);
            break;
          case '$in':
            if (Array.isArray(operand) && operand.length > 0) {
              result = result.where(field, 'in', operand);
            }
            break;
          case '$like':
            result = result.where(field, 'like', operand);
            break;
          case '$null':
            result = operand
              ? result.where(field, 'is', null)
              : result.where(field, 'is not', null);
            break;
          case '$ne':
            result = result.where(field, '!=', operand);
            break;
          case '$nin':
            if (Array.isArray(operand) && operand.length > 0) {
              result = result.where(field, 'not in', operand);
            }
            break;
        }
      }
    } else {
      result = result.where(field, '=', value);
    }
  }
  return result;
}

// ── Core operations ─────────────────────────────────────────────

export class RelationalOps {
  constructor(
    private db: DB,
    private metaMap: Map<string, AdapterMeta>,
    private ftsEntities: Set<string>,
    private dialect: DialectOps,
  ) {}

  private jf(meta: AdapterMeta): Set<string> {
    return jsonFieldNames(meta);
  }

  async read(meta: AdapterMeta, params?: ReadParams): Promise<EntityRecord | ReadPage> {
    const tbl = tableName(meta.entity);
    const jf = this.jf(meta);

    // Single record by id
    if (params?.id) {
      const row = await this.db
        .selectFrom(tbl)
        .where('id', '=', params.id)
        .selectAll()
        .executeTakeFirst();
      if (!row) throw entityNotFound(meta.entity, params.id);

      const record = deserializeRow(row as Record<string, unknown>, jf);
      if (useSoftDelete(meta) && record._deletedAt && !params.includeDeleted) {
        throw entityNotFound(meta.entity, params.id);
      }
      return record;
    }

    // Filtered list
    let q = this.db.selectFrom(tbl).selectAll();

    // Soft-delete filter
    if (useSoftDelete(meta) && !params?.includeDeleted) {
      q = q.where('_deletedAt', 'is', null);
    }

    // Where clause
    if (params?.where) {
      q = applyWhereClause(q, params.where as WhereClause);
    }

    // FTS search (dialect-specific)
    if (params?.search && this.ftsEntities.has(meta.entity)) {
      q = this.dialect.applyFtsFilter(q, tbl, params.search);
    }

    // Count total
    let countQ = this.db.selectFrom(tbl).select(sql`count(*)`.as('count'));
    if (useSoftDelete(meta) && !params?.includeDeleted) {
      countQ = countQ.where('_deletedAt', 'is', null);
    }
    if (params?.where) {
      countQ = applyWhereClause(countQ, params.where as WhereClause);
    }
    if (params?.search && this.ftsEntities.has(meta.entity)) {
      countQ = this.dialect.applyFtsFilter(countQ, tbl, params.search);
    }
    const countResult = (await countQ.executeTakeFirst()) as { count: number | string } | undefined;
    const total = Number(countResult?.count ?? 0);

    // Sort
    const sort = params?.sort?.length
      ? params.sort
      : [{ field: 'createdAt', direction: 'desc' as const }];
    for (const clause of sort) {
      q = q.orderBy(clause.field, clause.direction === 'desc' ? 'desc' : 'asc');
    }

    // Offset pagination
    const limit = Math.min(params?.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = params?.offset ?? 0;
    q = q.limit(limit).offset(offset);

    const rows = await q.execute();
    const records = (rows as Record<string, unknown>[]).map((r) => deserializeRow(r, jf));
    const hasMore = offset + limit < total;

    return { records, total, hasMore, offset, limit };
  }

  async create(meta: AdapterMeta, record: NewEntityRecord): Promise<EntityRecord> {
    const tbl = tableName(meta.entity);
    const jf = this.jf(meta);
    const now = new Date().toISOString();

    const full: Record<string, unknown> = {
      ...record,
      id: record.id ?? crypto.randomUUID(),
      _version: 1,
      createdAt: now,
      createdBy: (record.createdBy as string) ?? 'system',
      updatedAt: now,
      updatedBy: (record.updatedBy as string) ?? 'system',
    };

    await this.db.insertInto(tbl).values(this.dialect.serializeRow(full, jf)).execute();
    return full as EntityRecord;
  }

  async update(
    meta: AdapterMeta,
    id: string,
    patch: Record<string, unknown>,
    options?: UpdateOptions,
  ): Promise<EntityRecord> {
    const tbl = tableName(meta.entity);
    const jf = this.jf(meta);

    // Read existing
    const existing = await this.db
      .selectFrom(tbl)
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    if (!existing) throw entityNotFound(meta.entity, id);

    const deserialized = deserializeRow(existing as Record<string, unknown>, jf);
    if (useSoftDelete(meta) && deserialized._deletedAt) throw entityNotFound(meta.entity, id);

    if (options?.expectedVersion !== undefined && deserialized._version !== options.expectedVersion) {
      throw versionConflict(meta.entity, id, options.expectedVersion, deserialized._version);
    }

    const updated: Record<string, unknown> = {
      ...patch,
      _version: deserialized._version + 1,
      updatedAt: new Date().toISOString(),
    };

    // Don't allow overwriting immutable fields
    delete updated.id;
    delete updated.createdAt;

    await this.db
      .updateTable(tbl)
      .set(this.dialect.serializeRow(updated, jf))
      .where('id', '=', id)
      .execute();

    return { ...deserialized, ...updated } as EntityRecord;
  }

  async delete(meta: AdapterMeta, id: string): Promise<void> {
    const tbl = tableName(meta.entity);

    const existing = await this.db
      .selectFrom(tbl)
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    if (!existing) throw entityNotFound(meta.entity, id);

    if (useSoftDelete(meta)) {
      await this.db
        .updateTable(tbl)
        .set({ _deletedAt: new Date().toISOString() })
        .where('id', '=', id)
        .execute();
    } else {
      await this.db.deleteFrom(tbl).where('id', '=', id).execute();
    }
  }

  async count(meta: AdapterMeta, where: Record<string, unknown>): Promise<number> {
    const tbl = tableName(meta.entity);
    let q = this.db.selectFrom(tbl).select(sql`count(*)`.as('cnt'));
    if (useSoftDelete(meta)) {
      q = q.where('_deletedAt', 'is', null);
    }
    q = applyWhereClause(q, where);
    const row = await q.executeTakeFirstOrThrow();
    return Number((row as Record<string, unknown>).cnt);
  }

  async updateWhere(meta: AdapterMeta, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<number> {
    const tbl = tableName(meta.entity);
    const jf = jsonFieldNames(meta);
    const now = new Date().toISOString();
    const data = this.dialect.serializeRow({ ...patch, updatedAt: now }, jf);
    let q = this.db.updateTable(tbl).set(data);
    if (useSoftDelete(meta)) {
      q = q.where('_deletedAt', 'is', null);
    }
    q = applyWhereClause(q, where);
    const result = await q.execute();
    return Number(result[0]?.numUpdatedRows ?? 0);
  }
}
