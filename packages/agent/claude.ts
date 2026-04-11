/**
 * Claude API integration — wires discoverTools() to Claude's tool_use format,
 * manages multi-turn conversation, dispatches tool calls through the pipeline.
 *
 * This is the concrete adapter for the abstract agent surface, parallel to how
 * Hono is the concrete adapter in the HTTP package.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CompileResult, Identity } from '@janus/core';
import type { DispatchRuntime } from '@janus/pipeline';
import { discoverTools } from './context';
import type { ToolDescriptor, AgentResponse } from './types';

// ── Tool conversion ─────────────────────────────────────────────

/** Map Janus semantic type kinds (lowercase) to JSON Schema types. */
function jsonSchemaType(kind: string): string {
  switch (kind) {
    case 'int':
    case 'intcents':
    case 'intbps':
    case 'duration':
      return 'integer';
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'json':
      return 'object';
    default:
      return 'string';
  }
}

/**
 * Build a JSON Schema input_schema from a ToolDescriptor.
 *
 * Operation semantics:
 *   - create:               no `id`. Field requirements propagated from schema.
 *   - read:                 optional `id` (single record vs list). Other fields
 *                           are filter parameters; not required.
 *   - update / delete /     required `id`. Other fields are optional —
 *     lifecycle transitions just `id` is enough to perform the operation.
 *
 * Without this, an LLM looking at e.g. `contact__update` sees fields like
 * `name`, `email`, `notes` but no way to specify *which* contact to update,
 * and erroneously sees entity-level required fields as required for updates.
 */
function buildInputSchema(tool: ToolDescriptor): Anthropic.Messages.Tool.InputSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  const op = tool.operation;
  const isCreate = op === 'create';
  const isRead = op === 'read';
  // Anything that isn't create/read is a mutating operation that targets a
  // specific record by id (update, delete, lifecycle transitions).
  const isMutationById = !isCreate && !isRead;

  if (!isCreate) {
    properties['id'] = {
      type: 'string',
      description: isMutationById
        ? `The UUID of the ${tool.entity} record to ${op}.`
        : `Optional. Pass a UUID to fetch a single ${tool.entity} record. Omit (and use other fields as filters) to list records.`,
    };
    if (isMutationById) required.push('id');
  }

  for (const field of tool.fields) {
    if (field.interactionLevel === 'aware') continue; // agent can't write to redacted fields
    const prop: Record<string, unknown> = { type: jsonSchemaType(field.type) };
    if (field.operators?.length) {
      prop.description = `Query operators: ${field.operators.join(', ')}`;
    }
    properties[field.name] = prop;
    // Only propagate entity-schema "required" for create operations.
    // For update/delete/transitions, only `id` is genuinely required.
    if (field.required && isCreate) required.push(field.name);
  }

  return {
    type: 'object' as const,
    properties,
    ...(required.length ? { required } : {}),
  };
}

/** Build a human-readable description for a tool. */
function buildDescription(tool: ToolDescriptor): string {
  const parts = [`${tool.operation} on ${tool.entity}`];
  if (tool.description) parts.push(tool.description);
  if (tool.transitions?.length) parts.push(`Lifecycle transitions: ${tool.transitions.join(', ')}`);
  return parts.join('. ');
}

/**
 * Convert ToolDescriptor[] from discoverTools() into Claude API tool definitions.
 *
 * Tool names use `entity__operation` format (double underscore) since Claude tool
 * names must match ^[a-zA-Z0-9_-]+$ and entity names already use single underscores.
 */
export function toClaudeTools(tools: readonly ToolDescriptor[]): Anthropic.Messages.Tool[] {
  return tools.map((t) => ({
    name: `${t.entity}__${t.operation}`,
    description: buildDescription(t),
    input_schema: buildInputSchema(t),
  }));
}

/** Parse a Claude tool name back to (entity, operation). */
export function parseToolName(name: string): { entity: string; operation: string } {
  const idx = name.lastIndexOf('__');
  if (idx === -1) throw new Error(`Invalid tool name: '${name}'`);
  return { entity: name.slice(0, idx), operation: name.slice(idx + 2) };
}

// ── Agent loop ──────────────────────────────────────────────────

export interface AgentLoopConfig {
  /** The dispatch runtime (must be compiled with the agent surface initiator). */
  readonly runtime: DispatchRuntime;
  /** The compiled registry (for tool discovery). */
  readonly registry: CompileResult;
  /** The initiator name used for the agent surface. Default: 'agent-surface'. */
  readonly initiator?: string;
  /** Claude model to use. Default: 'claude-sonnet-4-6'. */
  readonly model?: string;
  /** System prompt. Auto-generated from tools if not provided. */
  readonly systemPrompt?: string;
  /**
   * Identity for dispatch calls. Uses SYSTEM if not provided.
   * Pass a function to support dynamic identity (e.g., a session whose
   * assignments may be updated between turns) — the function is called
   * once per tool dispatch.
   */
  readonly identity?: Identity | (() => Identity);
  /** Anthropic API key. Uses ANTHROPIC_API_KEY env var if not provided. */
  readonly apiKey?: string;
  /** Max tokens per response. Default: 4096. */
  readonly maxTokens?: number;
  /**
   * Optional allowlist of entity names. When set, only tools whose entity is
   * in this list are exposed to the model — every other discovered tool is
   * dropped before the schema is sent to Claude. Use this to give a narrowly
   * scoped agent (e.g. a triage worker or scheduled heartbeat) just the tools
   * it needs, instead of the full registry. When omitted, all discovered
   * tools are included (current behavior).
   */
  readonly toolEntities?: readonly string[];
  /**
   * Additional tools to register alongside auto-discovered entity tools.
   * Use this for Anthropic server tools (e.g. web_search) or custom client-side
   * tools handled via extraToolHandlers.
   */
  readonly extraTools?: readonly Anthropic.Messages.ToolUnion[];
  /**
   * Handlers for custom (non-entity) tool names. The key is the tool name
   * (matching the `name` field of the corresponding extraTools entry). The
   * handler is called with the parsed tool input and must return the result
   * payload that will be JSON-stringified and returned to Claude. Anthropic
   * server tools (web_search, etc.) execute server-side and do NOT need a
   * handler here.
   */
  readonly extraToolHandlers?: Readonly<Record<string, (input: unknown) => Promise<unknown> | unknown>>;
  /** Called when a tool is invoked. For logging/debugging. */
  readonly onToolCall?: (entity: string, operation: string, input: unknown) => void;
  /** Called when a tool returns. For logging/debugging. */
  readonly onToolResult?: (entity: string, operation: string, result: AgentResponse) => void;
  /**
   * Called once per Claude API response with the response's `usage` block.
   * Use this for token accounting and verifying prompt-cache hits
   * (`cache_read_input_tokens` > 0 means the request hit a warm cache).
   * Fired for every turn in the tool-use loop, for both chat() and chatStream().
   */
  readonly onUsage?: (usage: Anthropic.Messages.Usage) => void;
}

/** Callbacks emitted while streaming an assistant turn. */
export interface ChatStreamCallbacks {
  /** Called for each text delta as the assistant produces it. */
  onTextDelta?: (delta: string) => void;
  /** Called when the assistant starts producing text after a tool round trip. */
  onAssistantStart?: () => void;
  /** Called when the assistant finishes a contiguous text segment (between tool rounds, or at end). */
  onAssistantSegmentEnd?: (segmentText: string) => void;
}

export interface AgentLoop {
  /** Send a user message and get the assistant's text response. Handles tool calls internally. */
  chat(message: string): Promise<string>;
  /**
   * Like chat() but streams text deltas via callbacks. Still handles the
   * tool-use loop internally; the final string is the concatenation of all
   * text segments produced across tool rounds.
   */
  chatStream(message: string, callbacks: ChatStreamCallbacks): Promise<string>;
  /** The discovered tools in Claude API format (entity tools + extraTools). */
  readonly tools: readonly Anthropic.Messages.ToolUnion[];
  /** The conversation message history. */
  readonly messages: Anthropic.Messages.MessageParam[];
  /** Clear conversation history. */
  reset(): void;
}

/**
 * Build a system prompt from discovered tools.
 * Gives the model entity-graph awareness without hardcoding entity names.
 */
function buildSystemPrompt(tools: readonly ToolDescriptor[]): string {
  const entities = new Map<string, { description?: string; operations: string[]; transitions: string[] }>();

  for (const t of tools) {
    let entry = entities.get(t.entity);
    if (!entry) {
      entry = { description: t.description, operations: [], transitions: [] };
      entities.set(t.entity, entry);
    }
    entry.operations.push(t.operation);
    if (t.transitions) {
      for (const tr of t.transitions) {
        if (!entry.transitions.includes(tr)) entry.transitions.push(tr);
      }
    }
  }

  const lines = [
    'You are an assistant with access to an entity graph. You can read, create, update, and delete records using the tools provided.',
    '',
    'Available entities:',
  ];

  for (const [name, info] of entities) {
    let line = `- ${name}: ${info.description ?? 'No description'}`;
    line += ` [${info.operations.join(', ')}]`;
    if (info.transitions.length) line += ` (transitions: ${info.transitions.join(', ')})`;
    lines.push(line);
  }

  lines.push('');
  lines.push('Use read operations to look up data before making changes. When listing records, use read without an id. When getting a specific record, pass the id field.');

  return lines.join('\n');
}

/**
 * Create a Claude-powered agent conversation loop.
 *
 * Discovers tools from the registry, converts them to Claude format,
 * and manages multi-turn conversation with automatic tool dispatch.
 */
export function createAgentLoop(config: AgentLoopConfig): AgentLoop {
  const initiator = config.initiator ?? 'agent-surface';
  const model = config.model ?? 'claude-sonnet-4-6';
  const maxTokens = config.maxTokens ?? 4096;

  // Discover tools and convert to Claude format. If toolEntities is set,
  // filter to only the requested entities — this lets callers ship a narrow
  // tool schema to Claude instead of the entire registry.
  const allDiscoveredTools = discoverTools(config.registry, initiator);
  const discoveredTools = config.toolEntities
    ? allDiscoveredTools.filter((t) => config.toolEntities!.includes(t.entity))
    : allDiscoveredTools;
  const entityClaudeTools = toClaudeTools(discoveredTools);
  const claudeTools: Anthropic.Messages.ToolUnion[] = [
    ...entityClaudeTools,
    ...(config.extraTools ?? []),
  ];
  const extraToolHandlers = config.extraToolHandlers ?? {};
  const systemPrompt = config.systemPrompt ?? buildSystemPrompt(discoveredTools);
  // Wrap the system prompt in an ephemeral cache block. Identical system
  // prompts across calls within the cache TTL (~5 min) are billed at ~10% of
  // the input rate via cache_read_input_tokens. Stu's system prompt is ~10KB
  // and reused across every heartbeat cycle and chat turn, so this is the
  // single biggest cost win in the pipeline.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const client = new Anthropic({ apiKey: config.apiKey });
  const messages: Anthropic.Messages.MessageParam[] = [];

  async function handleToolUse(block: Anthropic.Messages.ToolUseBlock): Promise<Anthropic.Messages.ToolResultBlockParam> {
    // Custom (non-entity) tool — route to extraToolHandlers if registered.
    // Note: Anthropic server tools (web_search, etc.) execute server-side and
    // never reach this handler — they appear as separate content blocks.
    if (block.name in extraToolHandlers) {
      config.onToolCall?.('__custom__', block.name, block.input);
      try {
        const result = await extraToolHandlers[block.name](block.input);
        config.onToolResult?.('__custom__', block.name, { ok: true, data: result });
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        config.onToolResult?.('__custom__', block.name, { ok: false, error: { kind: 'handler-error', message } });
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: JSON.stringify({ ok: false, error: { kind: 'handler-error', message } }),
        };
      }
    }

    const { entity, operation } = parseToolName(block.name);
    const parameters = block.input as Record<string, unknown>;

    config.onToolCall?.(entity, operation, parameters);

    try {
      const id = typeof config.identity === 'function' ? config.identity() : config.identity;
      const result = await config.runtime.dispatch(
        initiator,
        entity,
        operation,
        parameters,
        id,
        { agentRequest: { agentId: 'claude', parameters } },
      );

      const agentResponse: AgentResponse = (result.extensions?.agentResponse as AgentResponse | undefined) ?? {
        ok: result.ok,
        data: result.data,
        meta: { entity, operation, interactionLevels: {} },
        ...(result.error ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
      };

      config.onToolResult?.(entity, operation, agentResponse);

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(agentResponse),
      };
    } catch (err) {
      const errorResponse: AgentResponse = {
        ok: false,
        error: { kind: 'dispatch-error', message: err instanceof Error ? err.message : String(err) },
      };

      config.onToolResult?.(entity, operation, errorResponse);

      return {
        type: 'tool_result',
        tool_use_id: block.id,
        is_error: true,
        content: JSON.stringify(errorResponse),
      };
    }
  }

  const createMessage = () =>
    client.messages.create({ model, max_tokens: maxTokens, system: systemBlocks, tools: claudeTools, messages });

  async function chat(userMessage: string): Promise<string> {
    messages.push({ role: 'user', content: userMessage });

    let response = await createMessage();
    config.onUsage?.(response.usage);

    // Tool-use loop: dispatch in parallel until the model produces a final text response
    while (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolBlocks = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );
      const toolResults = await Promise.all(toolBlocks.map(handleToolUse));

      messages.push({ role: 'user', content: toolResults });
      response = await createMessage();
      config.onUsage?.(response.usage);
    }

    messages.push({ role: 'assistant', content: response.content });

    const textBlocks = response.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );
    return textBlocks.map((b) => b.text).join('\n');
  }

  async function chatStream(userMessage: string, callbacks: ChatStreamCallbacks): Promise<string> {
    messages.push({ role: 'user', content: userMessage });

    const allText: string[] = [];

    // Each iteration of this loop is one Claude turn. We stream text deltas
    // out via callbacks, then if the model wants to call tools we run them
    // and stream the next turn.
    while (true) {
      let segmentText = '';
      let started = false;

      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        tools: claudeTools,
        messages,
      });

      stream.on('text', (delta) => {
        if (!started) {
          started = true;
          callbacks.onAssistantStart?.();
        }
        segmentText += delta;
        callbacks.onTextDelta?.(delta);
      });

      const finalMessage = await stream.finalMessage();
      config.onUsage?.(finalMessage.usage);

      if (started) {
        callbacks.onAssistantSegmentEnd?.(segmentText);
        allText.push(segmentText);
      }

      if (finalMessage.stop_reason !== 'tool_use') {
        messages.push({ role: 'assistant', content: finalMessage.content });
        return allText.join('\n');
      }

      // Tool round: record the assistant turn, run the tools, then loop.
      messages.push({ role: 'assistant', content: finalMessage.content });

      const toolBlocks = finalMessage.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
      );
      const toolResults = await Promise.all(toolBlocks.map(handleToolUse));
      messages.push({ role: 'user', content: toolResults });
    }
  }

  function reset(): void {
    messages.length = 0;
  }

  return {
    chat,
    chatStream,
    tools: claudeTools,
    messages,
    reset,
  };
}
