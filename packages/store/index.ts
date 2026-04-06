/**
 * @janus/store — Entity persistence layer.
 */

// Re-export canonical store types from core
export type {
  EntityStore,
  EntityRecord,
  NewEntityRecord,
  ReadParams,
  ReadPage,
  SortClause,
  SortDirection,
  UpdateOptions,
} from '@janus/core';

export type { StoreAdapter, TransactionalAdapter, AdapterMeta } from './store-adapter';
export { useSoftDelete } from './adapter-utils';
export type { WhereClause, FieldFilter, PrimitiveValue } from './filter';
export { matchesWhere, matchesFieldFilter, compareValues, isOperatorObject } from './filter';
export type { CursorPayload } from './cursor';
export { encodeCursor, decodeCursor } from './cursor';
export { StoreException, entityNotFound, versionConflict, readOnlyEntity } from './errors';
export type { StoreError } from './errors';
export { generateCreateTable, generateCreateTablePg, generateFtsTable, generateFtsTriggers, generatePgFtsSetup, getSearchableFields, generateIndexes, tableName, diffSchema, sqliteType, postgresType } from './schema-gen';
export type { ColumnInfo, SchemaDiff, PgFtsSetup, TypeResolver } from './schema-gen';
export { RelationalOps, jsonFieldNames, deserializeRow, applyWhereClause } from './relational-ops';
export type { DialectOps } from './relational-ops';
export { createMemoryAdapter } from './memory-adapter';
export { createSqliteAdapter } from './sqlite-adapter';
export type { SqliteAdapterConfig } from './sqlite-adapter';
export { createPostgresAdapter } from './postgres-adapter';
export type { PostgresAdapterConfig } from './postgres-adapter';
export type { ReconcilableAdapter } from './store-adapter';
export { createDerivedAdapter } from './derived-adapter';
export type { DerivedAdapterConfig } from './derived-adapter';
export { createEntityStore } from './router';
export type { EntityStoreConfig } from './router';

// Schema reconciliation (ADR 04c)
export { createSchemaSnapshotStore, generateSnapshot } from './schema-snapshot';
export type { FieldSnapshot, EntitySnapshot, SchemaSnapshotStore } from './schema-snapshot';
export { classifyChanges, reconcileSchema, planReconciliation, applyReconciliation, SchemaReconciliationError } from './schema-reconcile';
export type { SchemaChange, ChangeKind, ChangeTier, ReconciliationPlan, ReconciliationReport } from './schema-reconcile';
