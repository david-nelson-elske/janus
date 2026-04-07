/**
 * OpenAI Realtime API integration — text and audio modes with tool calling.
 *
 * Connects via WebSocket, registers Janus entity tools, and handles
 * multi-turn conversation with automatic tool dispatch. Supports text-only
 * (default) or text+audio modalities with streaming audio relay.
 *
 * Uses gpt-realtime-mini by default.
 */

import { WebSocket } from 'ws';
import type { CompileResult, Identity } from '@janus/core';
import { SYSTEM } from '@janus/core';
import type { DispatchRuntime } from '@janus/pipeline';
import { discoverTools, discoverNavigationTools } from './context';
import type { ToolDescriptor, NavigationDescriptor, AgentResponse } from './types';

// ── Tool conversion to OpenAI Realtime format ──────────────────

function jsonSchemaType(kind: string): string {
  switch (kind) {
    case 'int': case 'intcents': case 'intbps': case 'duration': return 'integer';
    case 'float': return 'number';
    case 'bool': return 'boolean';
    case 'json': return 'object';
    default: return 'string';
  }
}

function buildParameters(tool: ToolDescriptor): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const field of tool.fields) {
    if (field.interactionLevel === 'aware') continue;
    const prop: Record<string, unknown> = { type: jsonSchemaType(field.type) };
    if (field.operators?.length) prop.description = `Query operators: ${field.operators.join(', ')}`;
    properties[field.name] = prop;
    if (field.required) required.push(field.name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export interface OpenAIRealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function toOpenAIRealtimeTools(tools: readonly ToolDescriptor[]): OpenAIRealtimeTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: `${t.entity}__${t.operation}`,
    description: `${t.operation} on ${t.entity}${t.description ? '. ' + t.description : ''}${t.transitions?.length ? '. Transitions: ' + t.transitions.join(', ') : ''}`,
    parameters: buildParameters(t),
  }));
}

export function navigationToOpenAIRealtimeTools(
  navTools: readonly NavigationDescriptor[],
): OpenAIRealtimeTool[] {
  return navTools.map((n) => {
    const name = `navigate__${n.entity}__${n.view}`;
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    if (n.requiresId) {
      properties.id = { type: 'string', description: `The ${n.entity} id to navigate to` };
      required.push('id');
    }

    return {
      type: 'function' as const,
      name,
      description: `Navigate to the ${n.label} view`,
      parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    };
  });
}

function parseToolName(name: string): { entity: string; operation: string } {
  const idx = name.lastIndexOf('__');
  if (idx === -1) throw new Error(`Invalid tool name: '${name}'`);
  return { entity: name.slice(0, idx), operation: name.slice(idx + 2) };
}

function buildSystemPrompt(
  tools: readonly ToolDescriptor[],
  navTools: readonly NavigationDescriptor[],
): string {
  const entities = new Map<string, { description?: string; operations: string[]; transitions: string[] }>();
  for (const t of tools) {
    let entry = entities.get(t.entity);
    if (!entry) { entry = { description: t.description, operations: [], transitions: [] }; entities.set(t.entity, entry); }
    entry.operations.push(t.operation);
    if (t.transitions) for (const tr of t.transitions) if (!entry.transitions.includes(tr)) entry.transitions.push(tr);
  }
  const lines = ['You are an assistant with access to an entity graph database. Use the tools to read, create, update, and delete records.', '', 'Available entities:'];
  for (const [name, info] of entities) {
    let line = `- ${name}: ${info.description ?? 'No description'} [${info.operations.join(', ')}]`;
    if (info.transitions.length) line += ` (transitions: ${info.transitions.join(', ')})`;
    lines.push(line);
  }
  lines.push('', 'Read without an id lists records. Read with an id gets one record.');

  if (navTools.length > 0) {
    lines.push('', 'Navigation tools:');
    for (const n of navTools) {
      lines.push(`- navigate__${n.entity}__${n.view}: Navigate to ${n.label}${n.requiresId ? ' (requires id)' : ''}`);
    }
    lines.push('', 'Use navigation tools when the user asks to see or go to a page.');
  }

  return lines.join('\n');
}

// ── Session ────────────────────────────────────────────────────

export interface NavigationRequest {
  readonly entity: string;
  readonly view: string;
  readonly path: string;
  readonly id?: string;
}

export type AudioFormat = 'pcm16' | 'g711_ulaw' | 'g711_alaw';

export interface TurnDetectionConfig {
  readonly type: 'server_vad';
  readonly threshold?: number;
  readonly prefix_padding_ms?: number;
  readonly silence_duration_ms?: number;
}

export interface RealtimeConfig {
  readonly runtime: DispatchRuntime;
  readonly registry: CompileResult;
  readonly initiator?: string;
  readonly model?: string;
  readonly apiKey: string;
  readonly identity?: Identity;
  readonly systemPrompt?: string;
  readonly navigation?: boolean;
  /** Additional navigation descriptors to register alongside auto-discovered ones. */
  readonly extraNavigation?: readonly NavigationDescriptor[];
  /** Modalities for the session. Defaults to ['text']. */
  readonly modalities?: readonly ('text' | 'audio')[];
  /** OpenAI voice for audio output (e.g. 'alloy', 'echo', 'shimmer'). */
  readonly voice?: string;
  /** Turn detection config. Defaults to server VAD when audio is enabled, null to disable. */
  readonly turnDetection?: TurnDetectionConfig | null;
  /** Audio format for input. Defaults to 'pcm16'. */
  readonly inputAudioFormat?: AudioFormat;
  /** Audio format for output. Defaults to 'pcm16'. */
  readonly outputAudioFormat?: AudioFormat;
  readonly onToolCall?: (entity: string, operation: string, input: unknown) => void;
  readonly onToolResult?: (entity: string, operation: string, result: AgentResponse) => void;
  readonly onNavigate?: (nav: NavigationRequest) => void;
  readonly onText?: (text: string) => void;
  /** Called with each audio output chunk (base64-encoded). */
  readonly onAudio?: (chunk: string) => void;
  /** Called when the complete audio transcript is available. */
  readonly onAudioTranscript?: (transcript: string) => void;
  /** Called when the user's speech has been transcribed. */
  readonly onUserTranscript?: (transcript: string) => void;
  /** Called when VAD detects speech started. */
  readonly onSpeechStarted?: () => void;
  /** Called when VAD detects speech stopped. */
  readonly onSpeechStopped?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface RealtimeSession {
  /** Send a text message and wait for the text response. */
  send(text: string): Promise<string>;
  /** Send a base64-encoded audio chunk. Only valid when audio modality is enabled. */
  sendAudio(chunk: string): void;
  /** Commit the audio input buffer and trigger a response. */
  commitAudio(): void;
  close(): void;
  readonly tools: readonly OpenAIRealtimeTool[];
  readonly modalities: readonly string[];
}

export async function createRealtimeSession(config: RealtimeConfig): Promise<RealtimeSession> {
  const initiator = config.initiator ?? 'agent-surface';
  const model = config.model ?? 'gpt-realtime-mini';
  const identity = config.identity ?? SYSTEM;

  const discoveredTools = discoverTools(config.registry, initiator);
  const autoNav = config.navigation !== false
    ? discoverNavigationTools(config.registry)
    : [];
  const navTools = config.extraNavigation
    ? [...autoNav, ...config.extraNavigation]
    : autoNav;
  const navMap = new Map(navTools.map((n) => [`navigate__${n.entity}__${n.view}`, n]));

  const realtimeTools = [
    ...toOpenAIRealtimeTools(discoveredTools),
    ...navigationToOpenAIRealtimeTools(navTools),
  ];
  const systemPrompt = config.systemPrompt ?? buildSystemPrompt(discoveredTools, navTools);

  const url = `wss://api.openai.com/v1/realtime?model=${model}`;
  const ws = new WebSocket(url, {
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const modalities = config.modalities ?? ['text'];
  const hasAudio = modalities.includes('audio');

  // Configure session
  const sessionConfig: Record<string, unknown> = {
    modalities: [...modalities],
    instructions: systemPrompt,
    tools: realtimeTools,
    tool_choice: 'auto',
  };

  if (hasAudio) {
    if (config.voice) sessionConfig.voice = config.voice;
    if (config.inputAudioFormat) sessionConfig.input_audio_format = config.inputAudioFormat;
    if (config.outputAudioFormat) sessionConfig.output_audio_format = config.outputAudioFormat;
    if (config.turnDetection !== undefined) {
      sessionConfig.turn_detection = config.turnDetection;
    }
    sessionConfig.input_audio_transcription = { model: 'whisper-1' };
  }

  ws.send(JSON.stringify({ type: 'session.update', session: sessionConfig }));

  // State for the current send() call
  let pendingResolve: ((text: string) => void) | null = null;
  let accumulatedText = '';
  let accumulatedTranscript = '';
  let hasTextInCurrentResponse = false;
  let processingToolCalls = false;

  ws.on('message', async (data: Buffer) => {
    const event = JSON.parse(data.toString());

    switch (event.type) {
      case 'response.text.delta':
        accumulatedText += event.delta ?? '';
        hasTextInCurrentResponse = true;
        break;

      case 'response.text.done':
        config.onText?.(event.text ?? accumulatedText);
        break;

      case 'response.function_call_arguments.done': {
        processingToolCalls = true;
        const callId = event.call_id;
        const name = event.name;
        const args = JSON.parse(event.arguments || '{}');

        // Navigation tool — handled via callback, not dispatch
        const navDescriptor = navMap.get(name);
        if (navDescriptor) {
          const path = navDescriptor.requiresId && args.id
            ? navDescriptor.path.replace(':id', args.id)
            : navDescriptor.path;
          const navRequest: NavigationRequest = {
            entity: navDescriptor.entity,
            view: navDescriptor.view,
            path,
            ...(args.id ? { id: args.id } : {}),
          };
          config.onNavigate?.(navRequest);
          ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true, navigated: path }) },
          }));
          break;
        }

        // Entity operation — dispatch through pipeline
        const { entity, operation } = parseToolName(name);
        config.onToolCall?.(entity, operation, args);

        try {
          const result = await config.runtime.dispatch(
            initiator, entity, operation, args, identity,
            { agentRequest: { agentId: 'openai-realtime', parameters: args } },
          );
          const agentResponse: AgentResponse = {
            ok: result.ok, data: result.data,
            ...(result.error ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
          };
          config.onToolResult?.(entity, operation, agentResponse);

          ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(agentResponse) },
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: false, error: { kind: 'error', message: String(err) } }) },
          }));
        }
        break;
      }

      case 'response.done': {
        if (processingToolCalls && !hasTextInCurrentResponse) {
          // Tool calls completed — now ask for the text follow-up
          processingToolCalls = false;
          ws.send(JSON.stringify({ type: 'response.create' }));
        } else if (hasTextInCurrentResponse && pendingResolve) {
          // Text response complete — resolve the send() promise
          const text = accumulatedText;
          accumulatedText = '';
          hasTextInCurrentResponse = false;
          processingToolCalls = false;
          pendingResolve(text);
          pendingResolve = null;
        } else if (pendingResolve) {
          // Empty response — resolve with empty string
          pendingResolve(accumulatedText || '(no response)');
          pendingResolve = null;
          accumulatedText = '';
          hasTextInCurrentResponse = false;
          processingToolCalls = false;
        }
        break;
      }

      // ── Audio events ──────────────────────────────────────
      case 'response.audio.delta':
        config.onAudio?.(event.delta ?? '');
        break;

      case 'response.audio_transcript.delta':
        accumulatedTranscript += event.delta ?? '';
        break;

      case 'response.audio_transcript.done':
        config.onAudioTranscript?.(event.transcript ?? accumulatedTranscript);
        accumulatedTranscript = '';
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) config.onUserTranscript?.(event.transcript);
        break;

      case 'input_audio_buffer.speech_started':
        config.onSpeechStarted?.();
        break;

      case 'input_audio_buffer.speech_stopped':
        config.onSpeechStopped?.();
        break;

      case 'error':
        config.onError?.(event.error);
        if (pendingResolve) {
          pendingResolve(`[Error: ${event.error?.message ?? 'unknown'}]`);
          pendingResolve = null;
        }
        break;
    }
  });

  return {
    tools: realtimeTools,
    modalities,

    send(text: string): Promise<string> {
      accumulatedText = '';
      accumulatedTranscript = '';
      hasTextInCurrentResponse = false;
      processingToolCalls = false;

      return new Promise<string>((resolve) => {
        pendingResolve = resolve;
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        }));
        ws.send(JSON.stringify({ type: 'response.create' }));
      });
    },

    sendAudio(chunk: string) {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: chunk,
      }));
    },

    commitAudio() {
      accumulatedText = '';
      accumulatedTranscript = '';
      hasTextInCurrentResponse = false;
      processingToolCalls = false;

      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    },

    close() { ws.close(); },
  };
}
