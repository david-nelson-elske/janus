/**
 * @janus/agent — Agent surface, tool discovery, session context, and model integrations.
 */

// Re-export the Anthropic SDK so downstream workspace packages can use it
// without declaring a duplicate dependency. This is the canonical way to
// reach the SDK from any workspace that already depends on @janus/agent.
export { default as Anthropic } from '@anthropic-ai/sdk';

export { agentSurface } from './surface';
export { deriveInteractionLevels, discoverTools, discoverNavigationTools, buildAgentContext } from './context';
export type { BuildAgentContextConfig } from './context';
export { createAgentLoop, toClaudeTools, parseToolName } from './claude';
export type { AgentLoopConfig, AgentLoop, ChatStreamCallbacks } from './claude';
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
