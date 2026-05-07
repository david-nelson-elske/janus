/**
 * @janus/core — Entity definition, participation, and compilation.
 *
 * The compile-time layer of the ADR-124 Participation Model.
 */

// ── Consumer API ────────────────────────────────────────────────

export { define, deriveOperations } from './define';
export { defineCapability } from './define-capability';
export { participate } from './participate';
export { subscribe } from './subscribe';
export { bind } from './bind';
export { compile, dispatchKey } from './compile';
export { drop } from './drop';
export { TimeGate, FieldCompare, Hours, Days, Minutes } from './invariants';
export type { TimeGateDirection, TimeGateOptions, CompareOp, FieldCompareOptions } from './invariants';
export {
  handler,
  seedHandlers,
  resolveHandler,
  getRegistry,
  clearRegistry,
  FRAMEWORK_HANDLERS,
} from './handler-registry';

// ── Types ───────────────────────────────────────────────────────

export type {
  // Operations & Events
  Operation,
  EventDescriptor,

  // Origin
  Origin,

  // Entity definition
  SchemaField,
  LifecycleEntry,
  WiringFieldEntry,
  TransitionTarget,
  GraphNodeRecord,
  DefineConfig,
  DefineResult,

  // Participation
  ExecutionHandler,
  HandlerEntry,
  ParticipationRecord,
  ParticipateConfig,
  ParticipateResult,
  ActionConfig,
  ActionKind,
  PolicyConfig,
  PolicyRule,
  RateLimitConfig,
  AuditConfig,
  ObserveConfig,
  InvariantConfig,
  AgentInteractionLevel,
  FailurePolicy,
  RetryConfig,
  HandlerColumn,

  // Capability
  CapabilityConfig,
  CapabilityContext,
  CapabilityHandler,
  CapabilityRecord,
  CapabilityResult,

  // Subscription
  EventTrigger,
  CronTrigger,
  SubscriptionTrigger,
  SubscriptionRecord,
  SubscriptionInput,
  EventSubscriptionInput,
  CronSubscriptionInput,
  SubscribeResult,

  // Binding
  ComponentType,
  FieldBindingConfig,
  BindingConfig,
  BindingInput,
  BindingRecord,
  BindingIndex,
  BindResult,
  LoaderContext,
  Loader,
  BindingRenderMode,
  BindingRequireResult,
  BindingRequire,

  // Declaration
  DeclarationRecord,
  DropResult,

  // Schema evolution
  EvolveConfig,

  // Identity
  Identity,
  ScopeAssignment,
  ScopeConfig,
  StoreScope,

  // Pipeline
  PipelineStage,
  FrozenPipeline,

  // Store types
  EntityStore,
  EntityRecord,
  NewEntityRecord,
  ReadPage,
  ReadParams,
  SortClause,
  SortDirection,
  UpdateOptions,
  PersistResult,
  RoutingRecord,
  AdapterKind,

  // Index
  IndexConfig,

  // Wiring
  WiringEdge,
  WiringIndex,

  // Asset backend
  AssetBackend,
  AssetMeta,
  AssetWriteResult,

  // Dispatch
  DispatchError,
  DispatchWarning,
  DispatchResponse,
  InternalDispatch,
  ConcernContext,
  HttpRequestContext,
  AgentRequestContext,

  // Query fields
  QueryFieldRecord,

  // Compile
  CompileResult,
  CompileFilter,
  InitiatorConfig,
} from './types';

// ── Constants ───────────────────────────────────────────────────

export {
  Created,
  Updated,
  Deleted,
  Acted,
  Transitioned,
  isMutationEvent,
  isActedEvent,
  ANONYMOUS,
  SYSTEM,
  ALL_OPERATIONS,
  WRITE_OPERATIONS,
  ENTITY_NAME,
  FIELD_NAME,
  MAX_ENTITY_NAME_LENGTH,
  CAPABILITY_NAME,
  MAX_CAPABILITY_NAME_LENGTH,
  Handler,
  MUTABLE_CTX_FIELDS,
  copyOwnCtxFields,
  setIdentity,
  createHandlerContext,
  OPERATORS_BY_TYPE,
  resolveEntityName,
  extractResultData,
  isReadPage,
} from './types';

// Re-export from @janus/vocabulary that consumers configuring capabilities
// reach for most often. Keeps a one-import path for `audit: AuditFull`.
export { AuditFull, AuditLight, AuditNone } from '@janus/vocabulary';
export type { AuditLevel, AuditLevelKind } from '@janus/vocabulary';
