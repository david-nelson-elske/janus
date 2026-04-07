/**
 * Handler() runtime registry.
 *
 * A module-level Map<string, HandlerEntry> that stores all registered handlers.
 * Framework handlers are seeded at bootstrap via seedHandlers().
 * Consumer handlers are registered as a side effect of participate() when inline actions are declared.
 *
 * STABLE — the runtime function registry is explicitly not an entity (ADR 02).
 * Handler() keys on junction records resolve from this Map at compile time.
 * This module survives as-is through all milestones.
 */

import type { ExecutionHandler, HandlerEntry } from './types';

// ── Module-level registry ───────────────────────────────────────

const registry = new Map<string, HandlerEntry>();

/**
 * Register a handler in the runtime registry.
 * Returns the key for convenience.
 * Throws if the key is already registered (unless overwrite is true).
 */
export function handler(key: string, fn: ExecutionHandler, description: string, overwrite = false): string {
  if (registry.has(key) && !overwrite) {
    throw new Error(`Handler '${key}' is already registered`);
  }
  registry.set(key, Object.freeze({ fn, description }));
  return key;
}

/**
 * Look up a handler by key.
 */
export function resolveHandler(key: string): HandlerEntry | undefined {
  return registry.get(key);
}

/**
 * Returns a read-only view of the registry.
 */
export function getRegistry(): ReadonlyMap<string, HandlerEntry> {
  return registry;
}

/**
 * Clear all registered handlers. For testing only.
 */
export function clearRegistry(): void {
  registry.clear();
}

// ── Framework handler catalog ───────────────────────────────────

export const FRAMEWORK_HANDLERS: ReadonlyArray<{ key: string; description: string }> = [
  { key: 'policy-lookup', description: 'Authorization via rule lookup' },
  { key: 'rate-limit-check', description: 'Rate limit counter check' },
  { key: 'schema-parse', description: 'Schema-driven input parsing and coercion' },
  { key: 'schema-validate', description: 'Schema + lifecycle + ownership validation' },
  { key: 'credential-generate', description: 'Auto-generate Token and QrCode values on create' },
  { key: 'invariant-check', description: 'Run predicate functions against proposed state' },
  { key: 'store-read', description: 'Read entity record(s) from store' },
  { key: 'store-create', description: 'Create entity record in store' },
  { key: 'store-update', description: 'Update entity record in store' },
  { key: 'store-delete', description: 'Delete entity record from store' },
  { key: 'emit-broker', description: 'Write event log and notify broker' },
  { key: 'audit-relational', description: 'Write audit records (relational store)' },
  { key: 'audit-memory', description: 'Write audit records (memory store)' },
  { key: 'observe-memory', description: 'Write observation records (best-effort)' },
  { key: 'respond-shaper', description: 'Shape dispatch result into response format' },
  { key: 'dispatch-adapter', description: 'Dispatch to entity:operation (subscription adapter)' },
  { key: 'http-receive', description: 'Parse HTTP request into dispatch input' },
  { key: 'http-identity', description: 'Resolve caller identity from HTTP request' },
  { key: 'identity-provision', description: 'Lookup/create local identity record from OIDC subject' },
  { key: 'http-respond', description: 'Shape dispatch result into HTTP response' },
  { key: 'agent-receive', description: 'Parse agent request into dispatch input' },
  { key: 'agent-identity', description: 'Resolve agent identity from request' },
  { key: 'agent-respond', description: 'Shape dispatch result with interaction level metadata' },
  { key: 'connector-distribute', description: 'Push entity changes to external system via connector (ADR 07c)' },
];

// Stub handler for M1 — real implementations come in M2 (pipeline package)
const stub: ExecutionHandler = async () => {};

/**
 * Register all framework-seeded handlers.
 *
 * UPDATE @ M2: Replace stubs with real handler implementations from the pipeline package.
 * seedHandlers() will import and register the actual parse/validate/store/emit/respond functions.
 *
 * UPDATE @ M6 (HTTP surface): Add transport handler registrations (http-receive, http-identity,
 * http-respond) to the catalog.
 *
 * UPDATE @ M9 (Agent surface): Add agent handler registrations (agent-receive, agent-identity,
 * agent-respond) to the catalog.
 */
export function seedHandlers(): void {
  for (const { key, description } of FRAMEWORK_HANDLERS) {
    if (!registry.has(key)) {
      handler(key, stub, description);
    }
  }
}
