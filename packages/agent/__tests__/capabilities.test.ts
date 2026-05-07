/**
 * Tests for capability primitive integration in the agent layer:
 *   - discoverCapabilities() filtering
 *   - toClaudeToolsFromCapabilities() schema conversion
 *   - createAgentLoop() exposes capabilities alongside entity tools
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  compile,
  clearRegistry,
  defineCapability,
} from '@janus/core';
import type { CapabilityContext, CompileResult } from '@janus/core';
import { Str, Int, Enum } from '@janus/vocabulary';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
} from '@janus/pipeline';
import type { DispatchRuntime } from '@janus/pipeline';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  agentSurface,
  discoverCapabilities,
  toClaudeToolsFromCapabilities,
  createAgentLoop,
} from '..';

const noopHandler = async (_input: unknown, _ctx: CapabilityContext) => ({ ok: true });

let registry: CompileResult;
let runtime: DispatchRuntime;
let surfaceName: string;

async function bootRegistry(extras: ReturnType<typeof defineCapability>[]) {
  clearRegistry();
  registerHandlers();

  const surface = agentSurface();
  surfaceName = surface.initiator.name;

  registry = compile(
    [...frameworkEntities, ...frameworkParticipations, ...extras],
    [surface.initiator],
  );

  const memoryAdapter = createMemoryAdapter();
  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memoryAdapter, memory: memoryAdapter },
  });
  await store.initialize();

  const broker = createBroker();
  runtime = createDispatchRuntime({ registry, store, broker });
}

beforeEach(async () => {
  await bootRegistry([
    defineCapability({
      name: 'drive__search',
      description: 'Search Drive in a single account',
      inputSchema: {
        query: Str({ required: true }),
        accountLabel: Enum(['personal', 'work', 'condo']),
        pageSize: Int(),
      },
      tags: ['drive', 'google'],
      handler: noopHandler,
    }),
    defineCapability({
      name: 'web__fetch',
      description: 'Fetch a URL',
      inputSchema: { url: Str({ required: true }) },
      tags: ['web'],
      handler: noopHandler,
    }),
    defineCapability({
      name: 'mail__bodyfetch',
      description: 'Backfill missing email bodies',
      inputSchema: { since: Str() },
      tags: ['mail', 'sync'],
      handler: noopHandler,
    }),
  ]);
});

afterEach(() => {
  clearRegistry();
});

// ── discoverCapabilities ────────────────────────────────────────

describe('discoverCapabilities', () => {
  test('returns every registered capability when no filter', () => {
    const caps = discoverCapabilities(registry);
    expect(caps.length).toBe(3);
    expect(caps.map((c) => c.name).sort()).toEqual([
      'drive__search',
      'mail__bodyfetch',
      'web__fetch',
    ]);
  });

  test('filters by include allowlist', () => {
    const caps = discoverCapabilities(registry, { include: ['drive__search', 'web__fetch'] });
    expect(caps.map((c) => c.name).sort()).toEqual(['drive__search', 'web__fetch']);
  });

  test('filters by tag (any-match)', () => {
    const caps = discoverCapabilities(registry, { tags: ['google'] });
    expect(caps.map((c) => c.name)).toEqual(['drive__search']);
  });

  test('combines include and tag filters with AND', () => {
    const caps = discoverCapabilities(registry, {
      include: ['drive__search', 'web__fetch'],
      tags: ['web'],
    });
    expect(caps.map((c) => c.name)).toEqual(['web__fetch']);
  });

  test('empty include array yields nothing', () => {
    const caps = discoverCapabilities(registry, { include: [] });
    expect(caps.length).toBe(0);
  });

  test('returns frozen array', () => {
    const caps = discoverCapabilities(registry);
    expect(Object.isFrozen(caps)).toBe(true);
  });
});

// ── toClaudeToolsFromCapabilities ──────────────────────────────

describe('toClaudeToolsFromCapabilities', () => {
  test('preserves capability name verbatim', () => {
    const caps = discoverCapabilities(registry);
    const tools = toClaudeToolsFromCapabilities(caps);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'drive__search',
      'mail__bodyfetch',
      'web__fetch',
    ]);
  });

  test('uses longDescription when provided, else description', () => {
    const cap = defineCapability({
      name: 'short__call',
      description: 'short',
      longDescription: 'long form for system prompt',
      inputSchema: { x: Str() },
      handler: noopHandler,
    });
    const [tool] = toClaudeToolsFromCapabilities([cap.record]);
    expect(tool.description).toBe('long form for system prompt');

    const cap2 = defineCapability({
      name: 'short__call2',
      description: 'just short',
      inputSchema: { x: Str() },
      handler: noopHandler,
    });
    const [tool2] = toClaudeToolsFromCapabilities([cap2.record]);
    expect(tool2.description).toBe('just short');
  });

  test('builds JSON Schema with correct types', () => {
    const caps = discoverCapabilities(registry);
    const tools = toClaudeToolsFromCapabilities(caps);
    const drive = tools.find((t) => t.name === 'drive__search')!;
    const props = drive.input_schema.properties as Record<string, { type: string }>;
    expect(props.query.type).toBe('string');
    expect(props.accountLabel.type).toBe('string');
    expect(props.pageSize.type).toBe('integer');
  });

  test('includes required fields from semantic-type hints', () => {
    const caps = discoverCapabilities(registry);
    const tools = toClaudeToolsFromCapabilities(caps);
    const drive = tools.find((t) => t.name === 'drive__search')!;
    expect(drive.input_schema.required).toContain('query');
  });

  test('includes enum values for Enum() fields', () => {
    const caps = discoverCapabilities(registry);
    const tools = toClaudeToolsFromCapabilities(caps);
    const drive = tools.find((t) => t.name === 'drive__search')!;
    const props = drive.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.accountLabel.enum).toEqual(['personal', 'work', 'condo']);
  });

  test('omits required when no field is required', () => {
    const cap = defineCapability({
      name: 'opt__call',
      description: 'all optional',
      inputSchema: { since: Str() },
      handler: noopHandler,
    });
    const [tool] = toClaudeToolsFromCapabilities([cap.record]);
    expect(tool.input_schema.required).toBeUndefined();
  });
});

// ── createAgentLoop wiring ─────────────────────────────────────

describe('createAgentLoop with capabilities', () => {
  test('exposes capability tools alongside entity tools', () => {
    const loop = createAgentLoop({
      runtime,
      registry,
      initiator: surfaceName,
      apiKey: 'test-key',
    });
    const names = loop.tools.map((t) => 'name' in t ? t.name : '');
    expect(names).toContain('drive__search');
    expect(names).toContain('web__fetch');
    expect(names).toContain('mail__bodyfetch');
  });

  test('capabilityNames allowlist filters surfaced tools', () => {
    const loop = createAgentLoop({
      runtime,
      registry,
      initiator: surfaceName,
      capabilityNames: ['drive__search'],
      apiKey: 'test-key',
    });
    const names = loop.tools.map((t) => 'name' in t ? t.name : '');
    expect(names).toContain('drive__search');
    expect(names).not.toContain('web__fetch');
    expect(names).not.toContain('mail__bodyfetch');
  });

  test('capabilityTags allowlist filters surfaced tools', () => {
    const loop = createAgentLoop({
      runtime,
      registry,
      initiator: surfaceName,
      capabilityTags: ['mail', 'web'],
      apiKey: 'test-key',
    });
    const names = loop.tools.map((t) => 'name' in t ? t.name : '');
    expect(names).toContain('web__fetch');
    expect(names).toContain('mail__bodyfetch');
    expect(names).not.toContain('drive__search');
  });

  test('empty capabilityNames suppresses every capability', () => {
    const loop = createAgentLoop({
      runtime,
      registry,
      initiator: surfaceName,
      capabilityNames: [],
      apiKey: 'test-key',
    });
    const names = loop.tools.map((t) => 'name' in t ? t.name : '');
    expect(names).not.toContain('drive__search');
    expect(names).not.toContain('web__fetch');
  });
});
