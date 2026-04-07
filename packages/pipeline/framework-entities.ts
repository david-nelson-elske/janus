/**
 * Framework-seeded entity definitions.
 *
 * These are the infrastructure entities the framework needs to operate.
 * They're compiled alongside consumer entities and get their own tables.
 *
 * UPDATE @ M4+: Add emit_records when broker writes to store.
 * UPDATE @ M7: Add subscription output tracking.
 */

import { define, participate } from '@janus/core';
import { Str, Int, DateTime, Json, Enum, Reference, Token, Lifecycle, Singleton, Persistent, Volatile, hours } from '@janus/vocabulary';

/**
 * execution_log — records what pipeline concerns and subscription adapters did.
 *
 * Replaces 9 separate output entities from the original ADR-124 design.
 * For now uses Persistent + Json payload (Append() file-backed payloads deferred).
 */
export const executionLog = define('execution_log', {
  schema: {
    handler: Str({ required: true }),
    source: Str({ required: true }),
    entity_id: Str(),
    status: Str({ required: true }),
    timestamp: DateTime({ required: true }),
    duration: Int(),
    attempt: Int(),
    retention: Str({ required: true }),
    payload: Json(),
  },
  storage: Persistent(),
  description: 'Execution history for pipeline concerns and subscription adapters',
  origin: 'framework',
});

/** execution_log participation — read + create only (append-only semantics) */
export const executionLogParticipation = participate(executionLog, {
  parse: false,     // framework writes directly, no input parsing
  validate: false,  // framework writes are trusted
  emit: false,      // don't emit events for log writes (avoid recursion)
});

/**
 * agent_session — Volatile per-user session tracking agent focus and binding context.
 *
 * Tracks what the user is looking at (per-user, volatile state) and which agent
 * is acting within the session.
 */
export const agentSession = define('agent_session', {
  schema: {
    agent_id: Str({ required: true }),
    user_id: Str({ required: true }),
    url: Str(),
    latest_binding_entity: Str(),
    latest_binding_view: Str(),
    active_bindings: Json(),
    last_activity: DateTime({ required: true }),
  },
  storage: Volatile({ retain: hours(24) }),
  description: 'Agent session tracking — volatile, per-process',
  origin: 'framework',
});

/** agent_session participation — framework writes directly, no parsing/validation/emit */
export const agentSessionParticipation = participate(agentSession, {
  parse: false,
  validate: false,
  emit: false,
});

// ── connector_binding — external ID ↔ local ID mapping (ADR 07c) ──

export const connectorBinding = define('connector_binding', {
  schema: {
    connector: Str({ required: true }),
    entity: Str({ required: true }),
    localId: Str({ required: true }),
    externalId: Str({ required: true }),
    externalSource: Str(),
    lastSyncedAt: DateTime(),
    watermark: Str(),
    direction: Enum(['ingest', 'distribute', 'bidirectional']),
    fieldOwnership: Json(),
  },
  indexes: [{ fields: ['connector', 'entity', 'externalId', 'externalSource'], unique: true }],
  storage: Persistent(),
  description: 'Maps external system IDs to local entity IDs for connector sync',
  origin: 'framework',
});

export const connectorBindingParticipation = participate(connectorBinding, {
  emit: false,
});

// ── asset — binary file metadata (ADR 08b) ────────────────────

export const asset = define('asset', {
  schema: {
    filename: Str({ required: true }),
    content_type: Str({ required: true }),
    size: Int({ required: true }),
    backend: Str({ required: true }),
    path: Str({ required: true }),
    checksum: Str({ required: true }),
    alt: Str(),
  },
  storage: Persistent(),
  owned: true,
  description: 'Binary file metadata. Actual bytes stored in the configured backend.',
  origin: 'framework',
});

export const assetParticipation = participate(asset, {
  emit: false,
});

// ── template — named templates with LiquidJS rendering (ADR 10b) ──

export const template = define('template', {
  schema: {
    name: Str({ required: true, unique: true }),
    format: Enum(['html', 'markdown', 'text']),
    entity: Str(),
    subject: Str(),
    body: Str({ required: true }),
    layout: Reference('template'),
    context: Json(),
  },
  indexes: [{ fields: ['name'], unique: true }],
  storage: Persistent(),
  description: 'Named templates with LiquidJS rendering and semantic type filters',
  origin: 'framework',
});

export const templateParticipation = participate(template, {
  emit: false,
});

// ── oidc_provider — OIDC provider configuration (Singleton) ──

export const oidcProvider = define('oidc_provider', {
  schema: {
    issuer: Str(),
    client_id: Str(),
    client_secret: Str(),
    roles_claim: Str(),
    scope_claim: Str(),
    role_map: Json(),
    identity_entity: Str(),
    subject_field: Str(),
  },
  storage: Singleton({
    defaults: {
      issuer: '',
      client_id: '',
      client_secret: '',
      roles_claim: 'realm_access.roles',
      scope_claim: 'scope',
    },
  }),
  description: 'OIDC provider configuration',
  origin: 'framework',
});

export const oidcProviderParticipation = participate(oidcProvider, {
  parse: false,
  validate: false,
  emit: false,
  policy: { rules: [
    { role: 'system', operations: '*' as const },
    { role: 'admin', operations: '*' as const },
  ] },
});

// ── session — auth sessions (Persistent) ─────────────────────

export const session = define('session', {
  schema: {
    subject: Str({ required: true }),
    identity_id: Str(),
    token: Token({ length: 32, expires: '24h' }),
    refresh_token: Str(),
    provider: Str({ required: true }),
    status: Lifecycle({ active: ['expired', 'revoked'], expired: [], revoked: [] }),
  },
  indexes: [
    { fields: ['subject'], unique: false },
  ],
  storage: Persistent(),
  owned: true,
  description: 'Auth sessions — browser and API',
  origin: 'framework',
});

export const sessionParticipation = participate(session, {
  emit: false,
  policy: { rules: [
    { role: 'system', operations: '*' as const },
    { role: 'admin', operations: '*' as const },
  ] },
});

export const frameworkEntities = [executionLog, agentSession, connectorBinding, asset, template, oidcProvider, session];
export const frameworkParticipations = [executionLogParticipation, agentSessionParticipation, connectorBindingParticipation, assetParticipation, templateParticipation, oidcProviderParticipation, sessionParticipation];
