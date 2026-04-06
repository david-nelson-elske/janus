/**
 * StoreAdapter — the internal contract each adapter implements.
 *
 * STABLE — adapters receive AdapterMeta (entity name, table name, schema, storage strategy)
 * and implement CRUD operations. The router dispatches to the correct adapter per entity.
 */

import type { StorageStrategy } from '@janus/vocabulary';
import type { SchemaField, IndexConfig, EvolveConfig, EntityRecord, NewEntityRecord, ReadPage, ReadParams, UpdateOptions } from '@janus/core';
import type { ReconciliationReport } from './schema-reconcile';

/**
 * Metadata passed to adapters for each operation. Replaces CompiledEntity from packages/next.
 */
export interface AdapterMeta {
  readonly entity: string;
  readonly table: string;
  readonly schema: Readonly<Record<string, SchemaField>>;
  readonly storage: StorageStrategy;
  readonly indexes?: readonly IndexConfig[];
  readonly evolve?: EvolveConfig;
}

export interface StoreAdapter {
  /** Create tables / initialize storage for an entity. */
  initialize(meta: AdapterMeta): Promise<void>;

  /** Unified read: id present → single record, absent → filtered page. */
  read(meta: AdapterMeta, params?: ReadParams): Promise<EntityRecord | ReadPage>;

  /** Create a new record. */
  create(meta: AdapterMeta, record: NewEntityRecord): Promise<EntityRecord>;

  /** Update a record by id. */
  update(meta: AdapterMeta, id: string, patch: Record<string, unknown>, options?: UpdateOptions): Promise<EntityRecord>;

  /** Delete a record by id (soft delete for persistent, hard delete for volatile). */
  delete(meta: AdapterMeta, id: string): Promise<void>;

  /** Count records matching a where clause (ADR 01d). */
  count(meta: AdapterMeta, where: Record<string, unknown>): Promise<number>;

  /** Update all records matching a where clause. Returns count of updated rows (ADR 01d). */
  updateWhere(meta: AdapterMeta, where: Record<string, unknown>, patch: Record<string, unknown>): Promise<number>;
}

export interface TransactionalAdapter extends StoreAdapter {
  /** Run operations inside a transaction. */
  withTransaction<T>(fn: (tx: StoreAdapter) => Promise<T>): Promise<T>;
}

export interface ReconcilableAdapter extends StoreAdapter, TransactionalAdapter {
  /** Finalize initialization: run reconciliation, create tables, setup FTS/indexes. */
  finalize(drops?: ReadonlySet<string>): Promise<ReconciliationReport | null>;
}
