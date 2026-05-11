/**
 * @janus/controllers — v1 controller primitives.
 *
 * Spec: .planning/CONTROLLER-API-AND-ROUTER.md (in Perspicuity).
 *
 * Server-safe exports: declaration, registry, manifest, SSR helpers.
 * Client-only modules: `@janus/controllers/client` (bootstrap),
 * `@janus/controllers/base` (the JanusController base class).
 */

// Declarations + types
export type {
  ActorSurface,
  ControllerDeclaration,
  InvokableActionDecl,
  ValueTypeDecl,
} from './declare';
export { declareController } from './declare';

// Registry
export type { ControllerRegistry } from './registry';
export { lookupController, UnknownControllerError } from './registry';

// Manifest
export type {
  ManifestAgentAction,
  ManifestAgentEntry,
  ManifestCompositionInput,
  ManifestControllerEntry,
  ManifestControllerInput,
  ManifestSubscription,
  PageManifest,
} from './manifest';
export { composeManifest, renderClientScript, renderManifestScript } from './manifest';

// SSR attribute helpers
export { actionAttr, controllerAttrs, targetAttr } from './attrs';
