/**
 * @janus/vocabulary — Typed constructors for the entity-native framework.
 *
 * Nine vocabulary categories. No runtime behavior. No strings in consumer APIs.
 * Every constructor returns a frozen discriminated union value.
 */

export type { AuditLevel, AuditLevelKind } from './audit-levels';
// Audit levels
export { AuditFull, AuditLight, AuditNone } from './audit-levels';
export type { Classification, ClassificationKind, ClassifiedSchema } from './classifications';
// Classifications
export { Private, PrivateC, Public, PublicC, Sensitive, SensitiveC } from './classifications';
export type { DurationMs } from './duration';
// Duration helpers (value constructors for configuration)
export { days, hours, minutes, parseDuration, seconds, weeks } from './duration';
export type { EventDescriptor, EventDescriptorKind } from './event-descriptors';
// Event descriptors
export {
  Acted,
  ActionInvoked,
  Browsed,
  Created,
  Deleted,
  isActionInvoked,
  isMutationEvent,
  isTransitioned,
  Retrieved,
  Transitioned,
  Updated,
} from './event-descriptors';
export type { InvariantDescriptor, InvariantSeverity } from './invariants';
// Invariants
export { Invariant } from './invariants';
export type { LifecycleDescriptor, NamedLifecycle, TransitionMap } from './lifecycles';
// Lifecycles
export { defineLifecycle, isLifecycle, Lifecycle } from './lifecycles';
export type { Operation, OperationKind } from './operations';
// Operations
export {
  Act,
  Browse,
  Create,
  Delete,
  Get,
  GetById,
  isActOp,
  isReadOp,
  isTransitionOp,
  needsExistingRecord,
  Process,
  Transition,
  Update,
} from './operations';
export type {
  AssetField,
  AssetHints,
  AvailabilityField,
  BoolField,
  ColorField,
  CronField,
  DateTimeField,
  DateTimeHints,
  DurationField,
  EmailField,
  EnumField,
  FieldHints,
  FieldRole,
  FloatField,
  IconField,
  IdField,
  IntBpsField,
  IntCentsField,
  IntField,
  JsonField,
  LatLngField,
  MarkdownField,
  PhoneField,
  QrCodeField,
  QrCodeHints,
  RecurrenceField,
  ScopeField,
  SemanticField,
  SemanticFieldKind,
  SlugField,
  StrField,
  StrHints,
  TemplateField,
  TemplateHints,
  TokenField,
  TokenHints,
  UrlField,
} from './semantic-types';
// Semantic types (22 value + 4 compound)
export {
  Asset,
  Availability,
  Bool,
  // Visual types
  Color,
  Cron,
  // Temporal types
  DateTime,
  Duration,
  Email,
  Enum,
  Float,
  Icon,
  // Identity types
  Id,
  Int,
  IntBps,
  // Monetary types
  IntCents,
  // Type guard + validation
  isSemanticField,
  validateSemanticValue,
  Json,
  LatLng,
  // Content types
  Markdown,
  Phone,
  QrCode,
  // Compound types
  Recurrence,
  Scope,
  Slug,
  // Value types
  Str,
  Template,
  Token,
  Url,
} from './semantic-types';
export type {
  AdapterHintRelational,
  AdapterHintVolatile,
  CacheConfig,
  ComputeDerivedConfig,
  DerivedConfig,
  DerivedStrategy,
  PersistentStrategy,
  SimpleDerivedConfig,
  SingletonStrategy,
  StorageStrategy,
  StorageStrategyMode,
  VirtualProvider,
  VirtualStrategy,
  VolatileStrategy,
} from './storage-strategies';
// Storage strategies
export {
  Derived,
  isComputeDerived,
  isDerived,
  isPersistent,
  isSimpleDerived,
  isSingleton,
  isVirtual,
  isVolatile,
  Persistent,
  Singleton,
  Virtual,
  Volatile,
} from './storage-strategies';
export type {
  MentionField,
  OnDeletePolicy,
  ReferenceField,
  RelationField,
  TransitionAction,
  WiringEffects,
  WiringFieldKind,
  WiringType,
} from './wiring-types';
// Wiring types
export {
  isMention,
  isReference,
  isRelation,
  isWiringType,
  Mention,
  Reference,
  Relation,
  validateWiringValue,
} from './wiring-types';
export type {
  AuditConfig,
  EmitConfig,
  InvariantInput,
  ObserveConfig,
  ParseConfig,
  PolicyConfig,
  PolicyRuleInput,
  RateLimitInput,
  RespondConfig,
  ValidateConfig,
} from './capability-constructors';
// Capability constructors
export {
  Audit,
  Emit,
  Observe,
  Parse,
  Policy,
  Respond,
  Validate,
} from './capability-constructors';
export type { StepConfig } from './step-config';
export { createStepConstructor } from './step-config';
// Translatable wrapper (i18n, ADR 125-00)
export type { TranslatableField } from './translatable';
export {
  isTranslatableField,
  Translatable,
  translatableColumnName,
  unwrapTranslatable,
} from './translatable';
export type { Sensitivity, MountTrust } from './sensitivity';
// Sensitivity
export { sensitivityAllowsMount } from './sensitivity';
export type {
  InternalExecutionConfig,
  ServerExecutionConfig,
  TransportExecutionConfig,
} from './execution-presets';
// Execution presets
export { InternalExecution, ServerExecution, TransportExecution } from './execution-presets';
