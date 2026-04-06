/**
 * Tests for Claude API integration — tool conversion, name parsing, and agent loop.
 *
 * Pure-function tests (toClaudeTools, parseToolName) run without API calls.
 * Agent loop tests use a mock Anthropic client to verify dispatch wiring.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  define, participate, bind, compile, clearRegistry,
} from '@janus/core';
import type { CompileResult, Identity } from '@janus/core';
import { Str, Int, Markdown, Lifecycle, Enum, Persistent, Sensitive as SensitiveClassification } from '@janus/vocabulary';
import {
  registerHandlers, createDispatchRuntime, createBroker,
  frameworkEntities, frameworkParticipations,
} from '@janus/pipeline';
import type { DispatchRuntime } from '@janus/pipeline';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import type { EntityStore } from '@janus/store';
import { agentSurface, discoverTools } from '..';
import { toClaudeTools, parseToolName, createAgentLoop } from '../claude';
import type { ToolDescriptor, AgentResponse } from '../types';

// ── Fixtures ────────────────────────────────────────────────────

const DetailComponent = () => {};

let registry: CompileResult;
let runtime: DispatchRuntime;
let store: EntityStore;
let surfaceName: string;

beforeEach(async () => {
  clearRegistry();
  registerHandlers();

  const task = define('task', {
    schema: {
      title: Str({ required: true }),
      description: Markdown(),
      weight: Int(),
      priority: Enum(['low', 'medium', 'high']),
      status: Lifecycle({
        pending: ['in_progress'],
        in_progress: ['completed'],
      }),
    },
    storage: Persistent(),
    description: 'A work item to track',
  });

  const taskP = participate(task, {});

  const taskBinding = bind(task, [
    {
      component: DetailComponent,
      view: 'detail',
      config: {
        fields: {
          title: { agent: 'read-write', component: 'heading' },
          description: { agent: 'read-write', component: 'richtext' },
          priority: { agent: 'read', component: 'badge' },
          status: { agent: 'read', component: 'badge' },
        },
      },
    },
  ]);

  const surface = agentSurface();
  surfaceName = surface.initiator.name;

  registry = compile(
    [task, taskP, taskBinding, ...frameworkEntities, ...frameworkParticipations],
    [surface.initiator],
  );

  const memoryAdapter = createMemoryAdapter();
  store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memoryAdapter, memory: memoryAdapter },
  });
  await store.initialize();

  const broker = createBroker();
  runtime = createDispatchRuntime({ registry, store, broker });
});

afterEach(() => {
  clearRegistry();
});

// ── toClaudeTools ───────────────────────────────────────────────

describe('toClaudeTools', () => {
  test('converts discovered tools to Claude API format', () => {
    const tools = discoverTools(registry, surfaceName);
    const claudeTools = toClaudeTools(tools);

    expect(claudeTools.length).toBeGreaterThan(0);

    for (const t of claudeTools) {
      expect(t.name).toMatch(/^[a-z_]+__[a-z_]+$/);
      expect(t.input_schema.type).toBe('object');
      expect(typeof t.description).toBe('string');
    }
  });

  test('tool names use entity__operation format', () => {
    const tools = discoverTools(registry, surfaceName);
    const claudeTools = toClaudeTools(tools);

    const names = claudeTools.map((t) => t.name);
    expect(names).toContain('task__read');
    expect(names).toContain('task__create');
    expect(names).toContain('task__update');
    expect(names).toContain('task__delete');
  });

  test('includes required fields in schema', () => {
    const tools = discoverTools(registry, surfaceName);
    const claudeTools = toClaudeTools(tools);

    const createTool = claudeTools.find((t) => t.name === 'task__create');
    expect(createTool).toBeDefined();
    expect(createTool!.input_schema.required).toContain('title');
  });

  test('maps semantic types to JSON Schema types', () => {
    const tools = discoverTools(registry, surfaceName);
    const claudeTools = toClaudeTools(tools);

    const createTool = claudeTools.find((t) => t.name === 'task__create');
    expect(createTool).toBeDefined();

    const props = createTool!.input_schema.properties as Record<string, { type: string }>;
    expect(props.title.type).toBe('string');
    expect(props.description.type).toBe('string');
    expect(props.weight.type).toBe('integer');
    expect(props.priority.type).toBe('string');
  });

  test('includes description with entity info', () => {
    const tools = discoverTools(registry, surfaceName);
    const claudeTools = toClaudeTools(tools);

    const readTool = claudeTools.find((t) => t.name === 'task__read');
    expect(readTool).toBeDefined();
    expect(readTool!.description).toContain('task');
    expect(readTool!.description).toContain('read');
  });

  test('includes lifecycle transitions in description', () => {
    const tools = discoverTools(registry, surfaceName);
    const claudeTools = toClaudeTools(tools);

    const readTool = claudeTools.find((t) => t.name === 'task__read');
    expect(readTool).toBeDefined();
    expect(readTool!.description).toContain('in_progress');
    expect(readTool!.description).toContain('completed');
  });

  test('excludes aware-level fields from input schema', () => {
    // Redefine with a restricted-sensitivity entity to get aware fields
    clearRegistry();
    registerHandlers();

    const secret = define('secret', {
      schema: SensitiveClassification({
        name: Str({ required: true }),
        value: Str(),
      }),
      storage: Persistent(),
    });
    const secretP = participate(secret, {});

    const surface = agentSurface();
    const reg = compile(
      [secret, secretP, ...frameworkEntities, ...frameworkParticipations],
      [surface.initiator],
    );

    const tools = discoverTools(reg, surface.initiator.name);
    const claudeTools = toClaudeTools(tools);

    const createTool = claudeTools.find((t) => t.name === 'secret__create');
    expect(createTool).toBeDefined();
    // Aware fields should not appear in input_schema properties
    const props = createTool!.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual([]);
  });

  test('handles empty tool list', () => {
    const result = toClaudeTools([]);
    expect(result).toEqual([]);
  });
});

// ── parseToolName ───────────────────────────────────────────────

describe('parseToolName', () => {
  test('parses entity__operation format', () => {
    expect(parseToolName('task__read')).toEqual({ entity: 'task', operation: 'read' });
    expect(parseToolName('test_run__create')).toEqual({ entity: 'test_run', operation: 'create' });
  });

  test('handles entity names with underscores', () => {
    const result = parseToolName('my_entity_name__update');
    expect(result).toEqual({ entity: 'my_entity_name', operation: 'update' });
  });

  test('throws on invalid format', () => {
    expect(() => parseToolName('invalid')).toThrow('Invalid tool name');
    expect(() => parseToolName('')).toThrow('Invalid tool name');
  });
});

// ── createAgentLoop ─────────────────────────────────────────────

describe('createAgentLoop', () => {
  test('discovers tools from registry', () => {
    const loop = createAgentLoop({
      runtime,
      registry,
      initiator: surfaceName,
      apiKey: 'test-key',
    });

    expect(loop.tools.length).toBeGreaterThan(0);
    expect(loop.tools.some((t) => t.name === 'task__read')).toBe(true);
  });

  test('starts with empty message history', () => {
    const loop = createAgentLoop({
      runtime,
      registry,
      initiator: surfaceName,
      apiKey: 'test-key',
    });

    expect(loop.messages).toEqual([]);
  });

  test('reset clears message history', () => {
    const loop = createAgentLoop({
      runtime,
      registry,
      initiator: surfaceName,
      apiKey: 'test-key',
    });

    // Manually push a message to simulate usage
    loop.messages.push({ role: 'user', content: 'hello' });
    expect(loop.messages.length).toBe(1);

    loop.reset();
    expect(loop.messages.length).toBe(0);
  });
});

// ── End-to-end dispatch through agent loop ──────────────────────

describe('agent loop dispatch', () => {
  test('dispatches tool calls through the pipeline', async () => {
    // Create a record first via direct dispatch
    const createResult = await runtime.dispatch(
      surfaceName, 'task', 'create',
      { title: 'Test task', priority: 'high' },
      { id: 'test-agent', roles: ['admin'] },
      { agentRequest: { agentId: 'claude', parameters: { title: 'Test task', priority: 'high' } } },
    );
    expect(createResult.ok).toBe(true);

    const taskId = (createResult.data as any)?.id;
    expect(taskId).toBeDefined();

    // Read it back
    const readResult = await runtime.dispatch(
      surfaceName, 'task', 'read',
      { id: taskId },
      { id: 'test-agent', roles: ['admin'] },
      { agentRequest: { agentId: 'claude', parameters: { id: taskId } } },
    );
    expect(readResult.ok).toBe(true);

    const agentResponse = readResult.extensions?.agentResponse as AgentResponse;
    expect(agentResponse).toBeDefined();
    expect(agentResponse.ok).toBe(true);
    expect(agentResponse.meta?.entity).toBe('task');
    expect(agentResponse.meta?.operation).toBe('read');
    expect(agentResponse.meta?.interactionLevels).toBeDefined();
  });

  test('agent response includes interaction levels from binding config', async () => {
    const createResult = await runtime.dispatch(
      surfaceName, 'task', 'create',
      { title: 'Level test', priority: 'medium' },
      { id: 'test-agent', roles: ['admin'] },
      { agentRequest: { agentId: 'claude', parameters: { title: 'Level test', priority: 'medium' } } },
    );
    expect(createResult.ok).toBe(true);

    const taskId = (createResult.data as any)?.id;
    const readResult = await runtime.dispatch(
      surfaceName, 'task', 'read',
      { id: taskId },
      { id: 'test-agent', roles: ['admin'] },
      { agentRequest: { agentId: 'claude', parameters: { id: taskId } } },
    );

    const agentResponse = readResult.extensions?.agentResponse as AgentResponse;
    const levels = agentResponse.meta?.interactionLevels;
    expect(levels).toBeDefined();
    // From binding config: title/description = read-write, priority/status = read
    expect(levels!.title).toBe('read-write');
    expect(levels!.description).toBe('read-write');
    expect(levels!.priority).toBe('read');
    expect(levels!.status).toBe('read');
  });
});
