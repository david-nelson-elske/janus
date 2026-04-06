/**
 * Storage strategies — what mode of PERSISTENCE an entity uses.
 *
 * Each strategy is a typed constructor carrying its own configuration.
 * The framework routes to the correct adapter based on the strategy mode.
 */

import type { DurationMs } from './duration';
import type { EventDescriptor } from './event-descriptors';

// ── Cache configuration (shared) ─────────────────────────────────

export interface CacheConfig {
  readonly retain: DurationMs;
  readonly invalidateOn?: readonly EventDescriptor[];
}

// ── The discriminated union ──────────────────────────────────────

export type StorageStrategy =
  | PersistentStrategy
  | SingletonStrategy
  | VolatileStrategy
  | DerivedStrategy
  | VirtualStrategy;

export type StorageStrategyMode = StorageStrategy['mode'];

// ── Persistent ───────────────────────────────────────────────────

export type AdapterHintRelational = 'relational' | 'file';
export type AdapterHintVolatile = 'memory' | 'file';

export interface PersistentStrategy {
  readonly mode: 'persistent';
  readonly transactional: boolean;
  readonly order: number;
  readonly adapter?: AdapterHintRelational;
  readonly searchable?: boolean;
  readonly cache?: Readonly<CacheConfig>;
}

export function Persistent(config?: {
  adapter?: AdapterHintRelational;
  searchable?: boolean;
  cache?: CacheConfig;
}): PersistentStrategy {
  return Object.freeze({
    mode: 'persistent' as const,
    transactional: true,
    order: 30,
    adapter: config?.adapter,
    searchable: config?.searchable,
    cache: config?.cache ? Object.freeze(config.cache) : undefined,
  });
}

// ── Singleton ────────────────────────────────────────────────────

export interface SingletonStrategy {
  readonly mode: 'singleton';
  readonly transactional: boolean;
  readonly order: number;
  readonly defaults: Readonly<Record<string, unknown>>;
  readonly cache?: Readonly<CacheConfig>;
}

export function Singleton(config: {
  defaults: Record<string, unknown>;
  cache?: CacheConfig;
}): SingletonStrategy {
  return Object.freeze({
    mode: 'singleton' as const,
    transactional: true,
    order: 30,
    defaults: Object.freeze({ ...config.defaults }),
    cache: config.cache ? Object.freeze(config.cache) : undefined,
  });
}

// ── Volatile ─────────────────────────────────────────────────────

export interface VolatileStrategy {
  readonly mode: 'volatile';
  readonly transactional: boolean;
  readonly order: number;
  readonly retain: DurationMs;
  readonly adapter?: AdapterHintVolatile;
}

export function Volatile(config: {
  retain: DurationMs;
  adapter?: AdapterHintVolatile;
}): VolatileStrategy {
  return Object.freeze({
    mode: 'volatile' as const,
    transactional: true,
    order: 30,
    retain: config.retain,
    adapter: config?.adapter,
  });
}

// ── Derived (two forms) ──────────────────────────────────────────

export interface SimpleDerivedConfig {
  readonly from: string;
  readonly where: Readonly<Record<string, unknown>>;
  readonly sort?: Readonly<Record<string, 'asc' | 'desc'>>;
  readonly cache?: CacheConfig;
}

export interface ComputeDerivedConfig {
  readonly compute: (query: unknown, ctx: unknown) => Promise<unknown>;
  readonly cache?: CacheConfig;
}

export type DerivedConfig = SimpleDerivedConfig | ComputeDerivedConfig;

export interface DerivedStrategy {
  readonly mode: 'derived';
  readonly transactional: boolean;
  readonly order: number;
  readonly config: Readonly<DerivedConfig>;
}

export function isSimpleDerived(config: DerivedConfig): config is SimpleDerivedConfig {
  return 'from' in config;
}

export function isComputeDerived(config: DerivedConfig): config is ComputeDerivedConfig {
  return 'compute' in config;
}

export function Derived(config: DerivedConfig): DerivedStrategy {
  return Object.freeze({
    mode: 'derived' as const,
    transactional: false,
    order: 30,
    config: Object.freeze(config),
  });
}

// ── Virtual ──────────────────────────────────────────────────────

export interface VirtualProvider {
  readonly browse: (query: unknown) => Promise<unknown>;
  readonly getById: (id: string) => Promise<unknown>;
  readonly create?: (record: unknown) => Promise<unknown>;
  readonly update?: (id: string, patch: unknown) => Promise<unknown>;
}

export interface VirtualStrategy {
  readonly mode: 'virtual';
  readonly transactional: boolean;
  readonly order: number;
  readonly provider: Readonly<VirtualProvider>;
  readonly cache?: Readonly<CacheConfig>;
}

export function Virtual(config: {
  provider: VirtualProvider;
  cache?: CacheConfig;
}): VirtualStrategy {
  return Object.freeze({
    mode: 'virtual' as const,
    transactional: false,
    order: 30,
    provider: Object.freeze(config.provider),
    cache: config.cache ? Object.freeze(config.cache) : undefined,
  });
}

// ── Type guards ──────────────────────────────────────────────────

export function isPersistent(s: StorageStrategy): s is PersistentStrategy {
  return s.mode === 'persistent';
}
export function isSingleton(s: StorageStrategy): s is SingletonStrategy {
  return s.mode === 'singleton';
}
export function isVolatile(s: StorageStrategy): s is VolatileStrategy {
  return s.mode === 'volatile';
}
export function isDerived(s: StorageStrategy): s is DerivedStrategy {
  return s.mode === 'derived';
}
export function isVirtual(s: StorageStrategy): s is VirtualStrategy {
  return s.mode === 'virtual';
}
