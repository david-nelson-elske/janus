/**
 * @janus/agent — Agent surface, tool discovery, session context, and model integrations.
 */

// Re-export the Anthropic SDK so downstream workspace packages can use it
// without declaring a duplicate dependency. This is the canonical way to
// reach the SDK from any workspace that already depends on @janus/agent.
export { default as Anthropic } from '@anthropic-ai/sdk';

export { agentSurface } from './surface';
export {
  declareAgentSurface,
  validateAgentSurfaces,
  type AgentSurfaceDeclaration,
  type AgentSurfaceRegistry,
  type SurfaceSubscription,
  type SurfaceInvocation,
  type SurfaceRuntime,
  type SurfaceAudit,
  type ValidationRegistries,
} from './declare-surface';
export { deriveInteractionLevels, discoverTools, discoverCapabilities, discoverNavigationTools, buildAgentContext } from './context';
export type { BuildAgentContextConfig, DiscoverCapabilitiesOptions } from './context';
export { createAgentLoop, toClaudeTools, toClaudeToolsFromCapabilities, parseToolName, dispatchCapability, buildSystemPrompt } from './claude';
export type { AgentLoopConfig, AgentLoop, ChatStreamCallbacks, DispatchCapabilityConfig } from './claude';
export { createOpenAIAgentLoop, toOpenAITools } from './openai-chat';
export type { OpenAIAgentLoopConfig, OpenAIAgentLoop } from './openai-chat';
export { createRealtimeSession, toOpenAIRealtimeTools, navigationToOpenAIRealtimeTools } from './openai-realtime';
export type { RealtimeConfig, RealtimeSession, NavigationRequest, AudioFormat, TurnDetectionConfig } from './openai-realtime';
export type {
  AgentSurfaceConfig,
  AgentResponse,
  AgentSessionContext,
  SessionRecord,
  FocusedEntityContext,
  SessionBindingEntry,
  ToolDescriptor,
  ToolFieldDescriptor,
  NavigationDescriptor,
} from './types';
