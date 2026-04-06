/**
 * Register real handler implementations, replacing the M1 stubs.
 *
 * Uses FRAMEWORK_HANDLERS from core as the canonical catalog.
 * Provides real implementations for all M4 concerns.
 */

import type { ExecutionHandler } from '@janus/core';
import { clearRegistry, FRAMEWORK_HANDLERS, handler } from '@janus/core';
import { schemaParse } from './concerns/schema-parse';
import { schemaValidate } from './concerns/schema-validate';
import { storeRead, storeCreate, storeUpdate, storeDelete } from './concerns/store-handlers';
import { respondShaper } from './concerns/respond-shaper';
import { policyLookup } from './concerns/policy-lookup';
import { invariantCheck } from './concerns/invariant-check';
import { emitBroker } from './concerns/emit-broker';
import { auditRelational, createAuditHandler } from './concerns/audit-relational';
import { observeMemory } from './concerns/observe-memory';
import { dispatchAdapter } from './concerns/dispatch-adapter';
import { connectorDistribute } from './concerns/connector-distribute';
import { credentialGenerate } from './concerns/credential-generate';
import { httpReceive } from './concerns/http-receive';
import { httpIdentity } from './concerns/http-identity';
import { httpRespond } from './concerns/http-respond';
import { agentReceive } from './concerns/agent-receive';
import { agentIdentity } from './concerns/agent-identity';
import { agentRespond } from './concerns/agent-respond';
import { createRateLimitCheck } from './concerns/rate-limit-check';
import { createRateLimitStore } from './rate-limit-store';
import type { RateLimitStore } from './rate-limit-store';

/** Shared rate limit store, reset on each registerHandlers() call. */
let _rateLimitStore: RateLimitStore = createRateLimitStore();

/** Get the current rate limit store (for testing or custom wiring). */
export function getRateLimitStore(): RateLimitStore {
  return _rateLimitStore;
}

/**
 * Register all framework handlers with real implementations.
 * Call this instead of seedHandlers() for M2+ boots.
 */
export function registerHandlers(): void {
  clearRegistry();
  _rateLimitStore = createRateLimitStore();

  const implementations: Readonly<Record<string, ExecutionHandler>> = {
    'policy-lookup': policyLookup,
    'rate-limit-check': createRateLimitCheck(_rateLimitStore),
    'schema-parse': schemaParse,
    'schema-validate': schemaValidate,
    'credential-generate': credentialGenerate,
    'invariant-check': invariantCheck,
    'store-read': storeRead,
    'store-create': storeCreate,
    'store-update': storeUpdate,
    'store-delete': storeDelete,
    'emit-broker': emitBroker,
    'audit-relational': auditRelational,
    'audit-memory': createAuditHandler('audit-memory', 'volatile'),
    'observe-memory': observeMemory,
    'respond-shaper': respondShaper,
    'dispatch-adapter': dispatchAdapter,
    'connector-distribute': connectorDistribute,
    'http-receive': httpReceive,
    'http-identity': httpIdentity,
    'http-respond': httpRespond,
    'agent-receive': agentReceive,
    'agent-identity': agentIdentity,
    'agent-respond': agentRespond,
  };

  for (const { key, description } of FRAMEWORK_HANDLERS) {
    handler(key, implementations[key] ?? (async () => {}), description);
  }
}
