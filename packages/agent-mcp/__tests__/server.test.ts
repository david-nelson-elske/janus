/**
 * End-to-end tests for buildMcpServer using the SDK's in-memory transport.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  clearRegistry,
  compile,
  defineCapability,
  SYSTEM,
} from '@janus/core';
import type { CapabilityContext, CompileResult, Identity } from '@janus/core';
import { Str, Enum, Int } from '@janus/vocabulary';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
} from '@janus/pipeline';
import type { DispatchRuntime } from '@janus/pipeline';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import { agentSurface } from '@janus/agent';
import { buildMcpServer, plannedToolCount } from '..';

let registry: CompileResult;
let runtime: DispatchRuntime;
let surfaceName: string;

const search = defineCapability({
  name: 'drive__search',
  description: 'Search Drive',
  inputSchema: {
    query: Str({ required: true }),
    accountLabel: Enum(['personal', 'work', 'condo']),
    pageSize: Int(),
  },
  tags: ['drive', 'google'],
  handler: async ({ query }: { query: string }) => ({ files: [{ id: '1', name: query }] }),
});

const echo = defineCapability({
  name: 'web__fetch',
  description: 'Fetch URL',
  inputSchema: { url: Str({ required: true }) },
  tags: ['web'],
  handler: async ({ url }: { url: string }) => ({ url, body: '<html/>' }),
});

const failing = defineCapability({
  name: 'always__fail',
  description: 'Always throws',
  inputSchema: { x: Str() },
  handler: async (_input: unknown, _ctx: CapabilityContext) => {
    throw new Error('intentional');
  },
});

beforeEach(async () => {
  clearRegistry();
  registerHandlers();

  const surface = agentSurface();
  surfaceName = surface.initiator.name;

  registry = compile(
    [...frameworkEntities, ...frameworkParticipations, search, echo, failing],
    [surface.initiator],
  );

  const memoryAdapter = createMemoryAdapter();
  const store = createEntityStore({
    routing: registry.persistRouting,
    adapters: { relational: memoryAdapter, memory: memoryAdapter },
  });
  await store.initialize();
  runtime = createDispatchRuntime({ registry, store, broker: createBroker() });
});

afterEach(() => {
  clearRegistry();
});

async function connectClient(serverConfig?: Partial<Parameters<typeof buildMcpServer>[0]>): Promise<{ client: Client }> {
  const server = buildMcpServer({
    registry,
    runtime,
    initiator: surfaceName,
    ...serverConfig,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client };
}

// ── Tool registration ──────────────────────────────────────────

describe('buildMcpServer registration', () => {
  test('plannedToolCount reflects registered capabilities', () => {
    expect(plannedToolCount({ registry, runtime, initiator: surfaceName })).toBe(3);
  });

  test('capabilityNames filter scopes plannedToolCount', () => {
    expect(
      plannedToolCount({
        registry,
        runtime,
        initiator: surfaceName,
        capabilityNames: ['drive__search'],
      }),
    ).toBe(1);
  });

  test('capabilityTags filter scopes plannedToolCount', () => {
    expect(
      plannedToolCount({
        registry,
        runtime,
        initiator: surfaceName,
        capabilityTags: ['google'],
      }),
    ).toBe(1);
  });

  test('listTools surfaces every registered capability', async () => {
    const { client } = await connectClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['always__fail', 'drive__search', 'web__fetch']);
  });

  test('listTools respects capabilityNames allowlist', async () => {
    const { client } = await connectClient({ capabilityNames: ['drive__search'] });
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toEqual(['drive__search']);
  });

  test('tool inputSchema is populated from capability schema', async () => {
    const { client } = await connectClient();
    const result = await client.listTools();
    const drive = result.tools.find((t) => t.name === 'drive__search');
    expect(drive).toBeDefined();
    expect(drive!.inputSchema.required).toContain('query');
    const props = drive!.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
    expect(props.query.type).toBe('string');
    expect(props.pageSize.type).toBe('integer');
    expect(props.accountLabel.enum).toEqual(['personal', 'work', 'condo']);
  });
});

// ── Tool invocation ────────────────────────────────────────────

describe('buildMcpServer tool invocation', () => {
  test('callTool runs the capability handler and returns text content', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'drive__search',
      arguments: { query: 'hello' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');
    const data = JSON.parse(content[0].text);
    expect(data.files[0].name).toBe('hello');
  });

  test('callTool with missing required field returns isError', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({ name: 'drive__search', arguments: {} });
    expect(result.isError).toBe(true);
  });

  test('callTool with rejected enum value returns isError', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'drive__search',
      arguments: { query: 'ok', accountLabel: 'invalid' },
    });
    expect(result.isError).toBe(true);
  });

  test('handler errors surface as isError responses', async () => {
    const { client } = await connectClient();
    const result = await client.callTool({
      name: 'always__fail',
      arguments: { x: 'y' },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error.kind).toBe('capability-error');
    expect(payload.error.message).toBe('intentional');
  });

  test('identity factory is called per request', async () => {
    let calls = 0;
    const factory = (): Identity => {
      calls += 1;
      return { id: `caller-${calls}`, roles: ['user'] };
    };
    const { client } = await connectClient({ identity: factory });
    await client.callTool({ name: 'web__fetch', arguments: { url: 'https://x' } });
    await client.callTool({ name: 'web__fetch', arguments: { url: 'https://y' } });
    expect(calls).toBe(2);
  });

  test('static identity is reused across calls', async () => {
    const { client } = await connectClient({ identity: SYSTEM });
    const a = await client.callTool({ name: 'web__fetch', arguments: { url: 'https://x' } });
    const b = await client.callTool({ name: 'web__fetch', arguments: { url: 'https://y' } });
    expect((a.content as Array<{ text: string }>)[0].text).toBeDefined();
    expect((b.content as Array<{ text: string }>)[0].text).toBeDefined();
  });
});
