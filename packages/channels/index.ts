/**
 * @janus/channels — v1.5 channel primitives.
 *
 * Spec: `.planning/CHANNEL-DECLARATIONS.md` (in Perspicuity).
 *
 * Server-safe exports: declaration, registry, runtime (publish /
 * subscribe), bridge sink registration, persistence sink hook.
 *
 * Client-only module: `@janus/channels/client` (SSE subscribe).
 * Server-only module: `@janus/channels/server` (SSE bridge handler).
 */

// Declarations + types
export { declareChannel, valueMatchesType } from './declare';
export type {
  ActorRole,
  ChannelDeclaration,
  ChannelTypeDecl,
  PersistencePolicy,
} from './declare';
export type { PayloadOf, ScopeOf } from './types';

// Registry
export { lookupChannel, UnknownChannelError } from './registry';
export type { ChannelRegistry } from './registry';

// Runtime
export {
  createChannelBroker,
  initChannelBroker,
  getChannelBroker,
  publish,
  subscribe,
  _resetDefaultBrokerForTests,
} from './runtime';
export type {
  BridgeSink,
  ChannelBroker,
  ChannelEvent,
  ChannelHandler,
  PublishOptions,
  SubscribeOptions,
  Unsubscribe,
} from './runtime';
