/**
 * @janus/pipeline — Dispatch runtime, pipeline concerns, and broker.
 *
 * Public API: runtime, broker, subscription processor, framework entities,
 * and supporting infrastructure. Individual concern handlers are internal —
 * they're registered via registerHandlers() and resolved by handler key at
 * compile time. Import them directly from ./concerns/ only in tests.
 */

// ── Runtime ─────────────────────────────────────────────────────

export { createDispatchRuntime } from './dispatch';
export type { DispatchRuntime, DispatchRuntimeConfig, DispatchContext } from './dispatch';
export { buildContext } from './context';
export { registerHandlers, getRateLimitStore } from './register-handlers';

// ── Broker & subscriptions ──────────────────────────────────────

export { createBroker } from './broker';
export type { Broker, BrokerNotification, NotifyListener, NotifyFilter, Unsubscribe } from './broker';
export { startSubscriptionProcessor, executeSubscription, calculateBackoff } from './subscription-processor';
export type { SubscriptionProcessorConfig, SubscriptionProcessorHandle, ExecutionConfig } from './subscription-processor';
export { startScheduler } from './scheduler';
export type { SchedulerConfig, SchedulerHandle } from './scheduler';
export { parseCron, cronMatchesDate, nextCronMatch } from './cron';
export type { CronFields } from './cron';

// ── Framework entities ──────────────────────────────────────────

export { frameworkEntities, frameworkParticipations, executionLog, executionLogParticipation, agentSession, agentSessionParticipation, connectorBinding, connectorBindingParticipation, asset, assetParticipation, template, templateParticipation } from './framework-entities';

// ── Infrastructure ──────────────────────────────────────────────

export { renderTemplate, renderFromSchema, validateTemplateVariables } from './template-engine';
export type { RenderOptions, RenderResult, TemplateWarning } from './template-engine';
export { mergeOnIngest, filterForDistribute, isPingPong } from './connector-merge';
export type { FieldOwner, FieldOwnershipMap, MergeResult, DistributeFilterResult } from './connector-merge';
export { createLocalBackend } from './asset-backend';
export type { AssetBackend, AssetMeta, AssetWriteResult, LocalBackendConfig } from './asset-backend';
export { createRateLimitStore } from './rate-limit-store';
export type { RateLimitStore } from './rate-limit-store';
export { createConnectionManager } from './connection-manager';
export type { ConnectionManager, SseConnection, SseController, ServerMessage } from './connection-manager';
export { startBrokerSseBridge } from './broker-sse-bridge';

// ── Credential generation ──────────────────────────────────────

export { generateToken, generateQrCode, parseDuration } from './concerns/credential-generate';

// ── Types consumed by http/surface.ts ───────────────────────────

export type { HttpIdentityConfig, OidcConfig } from './concerns/http-identity';
export type { HttpResponse } from './concerns/http-respond';
