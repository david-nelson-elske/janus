/**
 * Capability constructors — typed, frozen config objects for each pipeline capability.
 *
 * Each constructor returns a frozen step config with an `order` field for pipeline
 * sequencing and an optional `adapter` field for routing.
 * The `kind` discriminator is removed — slot names identify capabilities.
 */

import type { AuditLevel } from './audit-levels';
import type { DurationMs } from './duration';
import type { EventDescriptor } from './event-descriptors';
import type { InvariantDescriptor } from './invariants';

// ── Parse ────────────────────────────────────────────────────────

export interface ParseConfig {
  readonly strict?: boolean;
  readonly transactional: false;
  readonly order: number;
}

export function Parse(config?: { strict?: boolean }): ParseConfig {
  return Object.freeze({
    strict: config?.strict,
    transactional: false as const,
    order: 10,
  });
}

// ── Validate (renamed from gate) ─────────────────────────────────

export interface ValidateConfig {
  readonly invariants?: readonly InvariantInput[];
  readonly transactional: false;
  readonly order: number;
}

/** Invariant input at the vocabulary level (no handler refs, just predicates). */
export interface InvariantInput {
  readonly name: string;
  // biome-ignore lint/suspicious/noExplicitAny: predicate operates on any entity record
  readonly predicate: (record: any, ctx?: any) => boolean | Promise<boolean>;
  readonly on?: readonly EventDescriptor[];
  readonly severity?: 'error' | 'warn';
}

export function Validate(config?: { invariants?: readonly InvariantInput[] }): ValidateConfig {
  return Object.freeze({
    invariants: config?.invariants ? Object.freeze([...config.invariants]) : undefined,
    transactional: false as const,
    order: 20,
  });
}

// ── Emit ─────────────────────────────────────────────────────────

export interface EmitConfig {
  readonly transactional: boolean;
  readonly order: number;
  readonly adapter: string;
}

export function Emit(config?: { transactional?: boolean }): EmitConfig {
  return Object.freeze({
    transactional: config?.transactional ?? true,
    order: 40,
    adapter: 'broker',
  });
}

// ── Observe ──────────────────────────────────────────────────────

export interface ObserveConfig {
  readonly on: readonly EventDescriptor[];
  readonly retain?: DurationMs;
  readonly metrics?: readonly string[];
  readonly capture?: readonly string[];
  readonly transactional: boolean;
  readonly order: number;
  readonly adapter: string;
}

export function Observe(config: {
  on: readonly EventDescriptor[];
  retain?: DurationMs;
  metrics?: readonly string[];
  capture?: readonly string[];
  transactional?: boolean;
}): ObserveConfig {
  return Object.freeze({
    on: Object.freeze([...config.on]),
    retain: config.retain,
    metrics: config.metrics ? Object.freeze([...config.metrics]) : undefined,
    capture: config.capture ? Object.freeze([...config.capture]) : undefined,
    transactional: config.transactional ?? false,
    order: 60,
    adapter: 'memory',
  });
}

// ── Audit ────────────────────────────────────────────────────────

export interface AuditConfig {
  readonly level?: AuditLevel;
  readonly retain?: DurationMs;
  readonly on?: readonly EventDescriptor[];
  readonly transactional: boolean;
  readonly order: number;
  readonly adapter: string;
}

export function Audit(config?: {
  level?: AuditLevel;
  retain?: DurationMs;
  on?: readonly EventDescriptor[];
  transactional?: boolean;
}): AuditConfig {
  return Object.freeze({
    level: config?.level,
    retain: config?.retain,
    on: config?.on ? Object.freeze([...config.on]) : undefined,
    transactional: config?.transactional ?? true,
    order: 50,
    adapter: 'relational',
  });
}

// ── Respond ──────────────────────────────────────────────────────

export interface RespondConfig {
  readonly transactional: false;
  readonly order: number;
}

export function Respond(config?: { transactional?: boolean }): RespondConfig {
  return Object.freeze({
    transactional: false as const,
    order: 70,
  });
}

// ── Policy ───────────────────────────────────────────────────────

/** Per-role operation policy for an entity (vocabulary-level). */
export interface PolicyRuleInput {
  readonly role: string;
  readonly operations: readonly string[] | '*';
  readonly ownershipField?: string;
  readonly rateMax?: number;
  readonly rateWindow?: number;
}

export interface PolicyConfig {
  readonly rules: readonly PolicyRuleInput[];
  readonly anonymousRead?: boolean;
  readonly rateLimits?: readonly RateLimitInput[];
  readonly order: number;
}

export interface RateLimitInput {
  readonly event: EventDescriptor;
  readonly window: DurationMs;
  readonly max: number;
}

export function Policy(config: {
  rules: readonly PolicyRuleInput[];
  anonymousRead?: boolean;
  rateLimits?: readonly RateLimitInput[];
}): PolicyConfig {
  return Object.freeze({
    rules: Object.freeze([...config.rules]),
    anonymousRead: config.anonymousRead,
    rateLimits: config.rateLimits ? Object.freeze([...config.rateLimits]) : undefined,
    order: 10,
  });
}
