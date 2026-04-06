/**
 * OpenAI Chat Completions integration — tool calling via standard REST API.
 *
 * Parallel to claude.ts but for OpenAI models. Uses the same discoverTools()
 * output, converted to OpenAI's function calling format.
 */

import OpenAI from 'openai';
import type { CompileResult, Identity } from '@janus/core';
import { SYSTEM } from '@janus/core';
import type { DispatchRuntime } from '@janus/pipeline';
import { discoverTools } from './context';
import type { ToolDescriptor, AgentResponse } from './types';

// ── Tool conversion ─────────────────────────────────────────────

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
    if (field.operators?.length) {
      prop.description = `Query operators: ${field.operators.join(', ')}`;
    }
    properties[field.name] = prop;
    if (field.required) required.push(field.name);
  }

  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export function toOpenAITools(tools: readonly ToolDescriptor[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: `${t.entity}__${t.operation}`,
      description: `${t.operation} on ${t.entity}${t.description ? '. ' + t.description : ''}${t.transitions?.length ? '. Transitions: ' + t.transitions.join(', ') : ''}`,
      parameters: buildParameters(t),
    },
  }));
}

function parseToolName(name: string): { entity: string; operation: string } {
  const idx = name.lastIndexOf('__');
  if (idx === -1) throw new Error(`Invalid tool name: '${name}'`);
  return { entity: name.slice(0, idx), operation: name.slice(idx + 2) };
}

// ── Agent loop ──────────────────────────────────────────────────

export interface OpenAIAgentLoopConfig {
  readonly runtime: DispatchRuntime;
  readonly registry: CompileResult;
  readonly initiator?: string;
  readonly model?: string;
  readonly apiKey: string;
  readonly identity?: Identity;
  readonly systemPrompt?: string;
  readonly onToolCall?: (entity: string, operation: string, input: unknown) => void;
  readonly onToolResult?: (entity: string, operation: string, result: AgentResponse) => void;
}

export interface OpenAIAgentLoop {
  chat(message: string): Promise<string>;
  readonly tools: readonly OpenAI.Chat.Completions.ChatCompletionTool[];
  readonly messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  reset(): void;
}

function buildSystemPrompt(tools: readonly ToolDescriptor[]): string {
  const entities = new Map<string, { description?: string; operations: string[]; transitions: string[] }>();
  for (const t of tools) {
    let entry = entities.get(t.entity);
    if (!entry) { entry = { description: t.description, operations: [], transitions: [] }; entities.set(t.entity, entry); }
    entry.operations.push(t.operation);
    if (t.transitions) for (const tr of t.transitions) if (!entry.transitions.includes(tr)) entry.transitions.push(tr);
  }
  const lines = ['You are an assistant with access to an entity graph. Use the tools to read, create, update, and delete records.', '', 'Available entities:'];
  for (const [name, info] of entities) {
    let line = `- ${name}: ${info.description ?? 'No description'} [${info.operations.join(', ')}]`;
    if (info.transitions.length) line += ` (transitions: ${info.transitions.join(', ')})`;
    lines.push(line);
  }
  lines.push('', 'Read without an id lists records. Read with an id gets one record. Use read before making changes.');
  return lines.join('\n');
}

export function createOpenAIAgentLoop(config: OpenAIAgentLoopConfig): OpenAIAgentLoop {
  const initiator = config.initiator ?? 'agent-surface';
  const model = config.model ?? 'gpt-realtime-mini';
  const identity = config.identity ?? SYSTEM;

  const discoveredTools = discoverTools(config.registry, initiator);
  const openaiTools = toOpenAITools(discoveredTools);
  const systemPrompt = config.systemPrompt ?? buildSystemPrompt(discoveredTools);

  const client = new OpenAI({ apiKey: config.apiKey });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  async function handleToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
  ): Promise<OpenAI.Chat.Completions.ChatCompletionToolMessageParam[]> {
    return Promise.all(toolCalls.map(async (tc) => {
      const { entity, operation } = parseToolName(tc.function.name);
      const args = JSON.parse(tc.function.arguments || '{}');

      config.onToolCall?.(entity, operation, args);

      try {
        const result = await config.runtime.dispatch(
          initiator, entity, operation, args, identity,
          { agentRequest: { agentId: 'openai', parameters: args } },
        );

        const agentResponse: AgentResponse = {
          ok: result.ok,
          data: result.data,
          ...(result.error ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
        };
        config.onToolResult?.(entity, operation, agentResponse);

        return { role: 'tool' as const, tool_call_id: tc.id, content: JSON.stringify(agentResponse) };
      } catch (err) {
        return {
          role: 'tool' as const,
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: { kind: 'dispatch-error', message: String(err) } }),
        };
      }
    }));
  }

  async function chat(userMessage: string): Promise<string> {
    messages.push({ role: 'user', content: userMessage });

    let response = await client.chat.completions.create({ model, messages, tools: openaiTools, tool_choice: 'auto' });
    let choice = response.choices[0];

    while (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
      messages.push(choice.message);
      const toolResults = await handleToolCalls(choice.message.tool_calls);
      messages.push(...toolResults);

      response = await client.chat.completions.create({ model, messages, tools: openaiTools, tool_choice: 'auto' });
      choice = response.choices[0];
    }

    messages.push(choice.message);
    return choice.message.content ?? '';
  }

  return {
    chat,
    tools: openaiTools,
    messages,
    reset() { messages.length = 1; }, // keep system prompt
  };
}
