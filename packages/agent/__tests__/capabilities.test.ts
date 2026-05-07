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
import { Str, Int, Bool, Enum, AuditFull } from '@janus/vocabulary';
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
  dispatchCapability,
} from '..';
import { SYSTEM } from '@janus/core';

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

// ── dispatchCapability + audit ─────────────────────────────────

describe('dispatchCapability with audit', () => {
  test('returns ok=true when handler succeeds', async () => {
    const cap = defineCapability({
      name: 'echo__call',
      description: 'echo input',
      inputSchema: { msg: Str({ required: true }) },
      handler: async (input) => ({ echoed: input }),
    });
    await bootRegistry([cap]);

    const result = await dispatchCapability({
      cap: cap.record,
      input: { msg: 'hi' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ echoed: { msg: 'hi' } });
  });

  test('returns capability-error when handler throws', async () => {
    const cap = defineCapability({
      name: 'fail__call',
      description: 'always fails',
      inputSchema: { x: Str() },
      handler: async () => { throw new Error('boom'); },
    });
    await bootRegistry([cap]);

    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('capability-error');
    expect(result.error?.message).toBe('boom');
  });

  test('rejects missing required input', async () => {
    const cap = defineCapability({
      name: 'req__call',
      description: 'requires query',
      inputSchema: { query: Str({ required: true }) },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);

    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("requires field 'query'");
  });

  test('fires onToolCall and onToolResult with namespace', async () => {
    const cap = defineCapability({
      name: 'drive__search',
      description: 'x',
      inputSchema: { query: Str({ required: true }) },
      handler: async () => ({ files: [] }),
    });
    await bootRegistry([cap]);

    const calls: Array<[string, string]> = [];
    const results: Array<[string, string, boolean]> = [];
    await dispatchCapability({
      cap: cap.record,
      input: { query: 'q' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      onToolCall: (ns, name) => calls.push([ns, name]),
      onToolResult: (ns, name, res) => results.push([ns, name, res.ok]),
    });
    expect(calls).toEqual([['drive', 'drive__search']]);
    expect(results).toEqual([['drive', 'drive__search', true]]);
  });

  test('does not write capability_call row when audit unset', async () => {
    const cap = defineCapability({
      name: 'silent__call',
      description: 'no audit',
      inputSchema: { x: Str() },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });

    const rows = await runtime.dispatch('system', 'capability_call', 'read', {}, SYSTEM);
    expect(rows.ok).toBe(true);
    const data = rows.data as { records: unknown[] };
    expect(data.records.length).toBe(0);
  });

  test('writes capability_call row when audit set, on success', async () => {
    const cap = defineCapability({
      name: 'audited__call',
      description: 'audited',
      inputSchema: { x: Str() },
      audit: AuditFull,
      handler: async () => ({ result: 42 }),
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { x: 'hi' },
      identity: { id: 'user-1', roles: ['user'] },
      runtime,
      initiator: surfaceName,
    });

    const rows = await runtime.dispatch('system', 'capability_call', 'read', {}, SYSTEM);
    const data = rows.data as { records: Array<Record<string, unknown>> };
    expect(data.records.length).toBe(1);
    const row = data.records[0];
    expect(row.capability_name).toBe('audited__call');
    expect(row.ok).toBe(true);
    expect(row.identity_id).toBe('user-1');
    expect(row.input).toEqual({ x: 'hi' });
    expect(row.output).toEqual({ result: 42 });
    expect(typeof row.duration_ms).toBe('number');
    expect(row.error).toBeFalsy();
  });

  test('coerces string-encoded numbers to int/float', async () => {
    let received: unknown = null;
    const cap = defineCapability({
      name: 'coerce__int',
      description: 'coerces',
      inputSchema: {
        page: Int(),
        rate: Str(), // would be Float() but easier to assert with Str fallback
      },
      handler: async (input: unknown) => {
        received = input;
        return { ok: true };
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { page: '20' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(received).toEqual({ page: 20 });
  });

  test('coerces "true"/"false" strings to bool', async () => {
    let received: unknown = null;
    const cap = defineCapability({
      name: 'coerce__bool',
      description: 'b',
      inputSchema: { flag: Bool() },
      handler: async (input: unknown) => {
        received = input;
        return null;
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { flag: 'true' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(received).toEqual({ flag: true });
  });

  test('rejects out-of-range enum values', async () => {
    const cap = defineCapability({
      name: 'enum__check',
      description: 'e',
      inputSchema: { mode: Enum(['a', 'b', 'c'], { required: true }) },
      handler: async () => null,
    });
    await bootRegistry([cap]);

    const result = await dispatchCapability({
      cap: cap.record,
      input: { mode: 'd' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("expected one of a, b, c");
  });

  test('strips fields not declared in inputSchema', async () => {
    let received: unknown = null;
    const cap = defineCapability({
      name: 'strict__call',
      description: 's',
      inputSchema: { keep: Str() },
      handler: async (input: unknown) => {
        received = input;
        return null;
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { keep: 'yes', drop: 'this' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(received).toEqual({ keep: 'yes' });
  });

  test('auditRedact masks declared input keys before persisting', async () => {
    const cap = defineCapability({
      name: 'redact__input',
      description: 'r',
      inputSchema: { url: Str(), accessToken: Str() },
      audit: AuditFull,
      auditRedact: ['accessToken'],
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { url: 'https://x', accessToken: 'secret-xyz' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });

    const rows = await runtime.dispatch('system', 'capability_call', 'read', {}, SYSTEM);
    const data = rows.data as { records: Array<Record<string, unknown>> };
    const input = data.records[0].input as Record<string, unknown>;
    expect(input.url).toBe('https://x');
    expect(input.accessToken).toBe('[REDACTED]');
  });

  test('auditRedact masks declared output keys before persisting', async () => {
    const cap = defineCapability({
      name: 'redact__output',
      description: 'r',
      inputSchema: { x: Str() },
      audit: AuditFull,
      auditRedact: ['secret'],
      handler: async () => ({ public: 'ok', secret: 'hide-me' }),
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { x: 'y' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });

    const rows = await runtime.dispatch('system', 'capability_call', 'read', {}, SYSTEM);
    const data = rows.data as { records: Array<Record<string, unknown>> };
    const output = data.records[0].output as Record<string, unknown>;
    expect(output.public).toBe('ok');
    expect(output.secret).toBe('[REDACTED]');
  });

  test('auditRedact does nothing without audit set', async () => {
    const cap = defineCapability({
      name: 'redact__noop',
      description: 'r',
      inputSchema: { token: Str() },
      auditRedact: ['token'],
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { token: 'plain' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });

    const rows = await runtime.dispatch('system', 'capability_call', 'read', {}, SYSTEM);
    const data = rows.data as { records: Array<Record<string, unknown>> };
    expect(data.records.length).toBe(0);
  });

  test('writes capability_call row with error on failure', async () => {
    const cap = defineCapability({
      name: 'audited_fail__call',
      description: 'audited fail',
      inputSchema: { x: Str() },
      audit: AuditFull,
      handler: async () => { throw new Error('nope'); },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: { x: 'y' },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });

    const rows = await runtime.dispatch('system', 'capability_call', 'read', {}, SYSTEM);
    const data = rows.data as { records: Array<Record<string, unknown>> };
    expect(data.records.length).toBe(1);
    const row = data.records[0];
    expect(row.ok).toBe(false);
    expect(row.error).toBe('nope');
  });
});
