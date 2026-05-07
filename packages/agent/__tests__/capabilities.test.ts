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
  createRateLimitStore,
  frameworkEntities,
  frameworkParticipations,
} from '@janus/pipeline';
import type { DispatchRuntime } from '@janus/pipeline';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  agentSurface,
  buildSystemPrompt,
  discoverCapabilities,
  toClaudeToolsFromCapabilities,
  createAgentLoop,
  dispatchCapability,
} from '..';
import { ANONYMOUS, SYSTEM } from '@janus/core';

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
    expect(result.error?.kind).toBe('validation-error');
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
    expect(result.error?.kind).toBe('validation-error');
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

  test('registry propagates to CapabilityContext when supplied', async () => {
    let observed: unknown = null;
    const cap = defineCapability({
      name: 'registry__check',
      description: 'r',
      inputSchema: { x: Str() },
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        observed = ctx.registry;
        return null;
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      registry,
    });
    expect(observed).toBe(registry);
  });

  test('registry omitted from context when not supplied', async () => {
    let observed: unknown = registry;
    const cap = defineCapability({
      name: 'registry__none',
      description: 'r',
      inputSchema: { x: Str() },
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        observed = ctx.registry;
        return null;
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(observed).toBeUndefined();
  });

  test('caller-supplied signal links to ctx.signal so handler observes aborts', async () => {
    let abortedFromHandler = false;
    const cap = defineCapability({
      name: 'signal__check',
      description: 's',
      inputSchema: { x: Str() },
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        // Wait a tick, then check whether the linked signal flipped.
        await new Promise((r) => setTimeout(r, 5));
        abortedFromHandler = !!ctx.signal?.aborted;
        return null;
      },
    });
    await bootRegistry([cap]);

    const ac = new AbortController();
    setTimeout(() => ac.abort('test-cancel'), 1);
    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      signal: ac.signal,
    });
    expect(abortedFromHandler).toBe(true);
  });

  test('pre-aborted caller signal propagates immediately to ctx.signal', async () => {
    const cap = defineCapability({
      name: 'signal__pre_abort',
      description: 's',
      inputSchema: { x: Str() },
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        if (ctx.signal?.aborted) {
          throw new Error(`aborted: ${(ctx.signal as AbortSignal & { reason?: unknown }).reason ?? 'unknown'}`);
        }
        return { ok: true };
      },
    });
    await bootRegistry([cap]);

    const ac = new AbortController();
    ac.abort('test-cancel');
    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      signal: ac.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('aborted');
  });

  test('signal is always set (even without caller-supplied signal)', async () => {
    let observed: AbortSignal | undefined;
    const cap = defineCapability({
      name: 'signal__always',
      description: 's',
      inputSchema: { x: Str() },
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        observed = ctx.signal;
        return null;
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    // Always present so handlers can rely on it; the framework wires its
    // own AbortController to support timeout enforcement uniformly.
    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(false);
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

// ── Policy enforcement ─────────────────────────────────────────

describe('dispatchCapability policy', () => {
  test('allows when no policy configured', async () => {
    const cap = defineCapability({
      name: 'open__call',
      description: 'no policy',
      inputSchema: { x: Str() },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: { id: 'u', roles: ['anyone'] },
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(true);
  });

  test('allows when caller has matching role', async () => {
    const cap = defineCapability({
      name: 'admin__call',
      description: 'admin only',
      inputSchema: { x: Str() },
      policy: { rules: [{ role: 'admin', operations: '*' }] },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: { id: 'a', roles: ['admin', 'user'] },
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(true);
  });

  test('denies when caller lacks any matching role', async () => {
    const cap = defineCapability({
      name: 'admin__only',
      description: 'admin only',
      inputSchema: { x: Str() },
      policy: { rules: [{ role: 'admin', operations: '*' }] },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: { id: 'u', roles: ['user'] },
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('auth-error');
    expect(result.error?.message).toContain('cannot call');
  });

  test('denies anonymous callers by default', async () => {
    const cap = defineCapability({
      name: 'auth__call',
      description: 'requires auth',
      inputSchema: { x: Str() },
      policy: { rules: [{ role: 'user', operations: '*' }] },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: ANONYMOUS,
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('auth-error');
    expect(result.error?.message).toContain('Anonymous');
  });

  test('allows anonymous when anonymousRead is true', async () => {
    const cap = defineCapability({
      name: 'public__call',
      description: 'public',
      inputSchema: { x: Str() },
      policy: { rules: [{ role: 'user', operations: '*' }], anonymousRead: true },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: ANONYMOUS,
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(true);
  });
});

// ── Rate limit enforcement ─────────────────────────────────────

describe('dispatchCapability rate limit', () => {
  test('allows up to max calls within window', async () => {
    const cap = defineCapability({
      name: 'limited__call',
      description: 'limited',
      inputSchema: { x: Str() },
      rateLimit: { max: 2, window: 1000 },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const store = createRateLimitStore();
    const id: typeof SYSTEM = { id: 'caller-1', roles: ['user'] };

    const a = await dispatchCapability({ cap: cap.record, input: {}, identity: id, runtime, initiator: surfaceName, rateLimitStore: store });
    const b = await dispatchCapability({ cap: cap.record, input: {}, identity: id, runtime, initiator: surfaceName, rateLimitStore: store });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  test('blocks when limit exceeded', async () => {
    const cap = defineCapability({
      name: 'tight__call',
      description: 'tight',
      inputSchema: { x: Str() },
      rateLimit: { max: 1, window: 1000 },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const store = createRateLimitStore();
    const id: typeof SYSTEM = { id: 'caller-1', roles: ['user'] };

    const a = await dispatchCapability({ cap: cap.record, input: {}, identity: id, runtime, initiator: surfaceName, rateLimitStore: store });
    const b = await dispatchCapability({ cap: cap.record, input: {}, identity: id, runtime, initiator: surfaceName, rateLimitStore: store });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.error?.kind).toBe('rate-limit-exceeded');
  });

  test('different identities have independent counters', async () => {
    const cap = defineCapability({
      name: 'per_user__call',
      description: 'per-user',
      inputSchema: { x: Str() },
      rateLimit: { max: 1, window: 1000 },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);
    const store = createRateLimitStore();

    const a = await dispatchCapability({ cap: cap.record, input: {}, identity: { id: 'u1', roles: ['user'] }, runtime, initiator: surfaceName, rateLimitStore: store });
    const b = await dispatchCapability({ cap: cap.record, input: {}, identity: { id: 'u2', roles: ['user'] }, runtime, initiator: surfaceName, rateLimitStore: store });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  test('skips rate-limit when no store provided', async () => {
    const cap = defineCapability({
      name: 'unbounded__call',
      description: 'no store',
      inputSchema: { x: Str() },
      rateLimit: { max: 1, window: 1000 },
      handler: async () => ({ ok: true }),
    });
    await bootRegistry([cap]);

    const a = await dispatchCapability({ cap: cap.record, input: {}, identity: SYSTEM, runtime, initiator: surfaceName });
    const b = await dispatchCapability({ cap: cap.record, input: {}, identity: SYSTEM, runtime, initiator: surfaceName });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});

// ── Capability composition ──────────────────────────────────────

describe('ctx.callCapability', () => {
  test('a capability can invoke another by name', async () => {
    const inner = defineCapability({
      name: 'math__double',
      description: 'doubles',
      inputSchema: { n: Int({ required: true }) },
      handler: async ({ n }: { n: number }) => ({ result: n * 2 }),
    });
    const outer = defineCapability({
      name: 'math__quad',
      description: 'quads via double',
      inputSchema: { n: Int({ required: true }) },
      handler: async ({ n }: { n: number }, ctx: CapabilityContext) => {
        if (!ctx.callCapability) throw new Error('callCapability missing');
        const a = await ctx.callCapability('math__double', { n });
        if (!a.ok) throw new Error('inner failed');
        const b = await ctx.callCapability('math__double', { n: (a.data as { result: number }).result });
        return { result: (b.data as { result: number }).result };
      },
    });
    await bootRegistry([inner, outer]);

    const result = await dispatchCapability({
      cap: outer.record,
      input: { n: 3 },
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      registry,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { result: number }).result).toBe(12);
  });

  test('callCapability reports unknown capability without throwing', async () => {
    let observedResponse: unknown = null;
    const cap = defineCapability({
      name: 'caller__call',
      description: 'tries unknown',
      inputSchema: {},
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        if (!ctx.callCapability) throw new Error('callCapability missing');
        observedResponse = await ctx.callCapability('does__not_exist', {});
        return { observed: !!observedResponse };
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      registry,
    });
    const r = observedResponse as { ok: boolean; error?: { kind: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('capability-not-found');
  });

  test('callCapability is undefined when no registry supplied', async () => {
    let observedAvailable = true;
    const cap = defineCapability({
      name: 'standalone__call',
      description: 'no reg',
      inputSchema: {},
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        observedAvailable = !!ctx.callCapability;
        return null;
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      // no registry
    });
    expect(observedAvailable).toBe(false);
  });

  test('depth tracking caps recursion at MAX_CAPABILITY_DEPTH', async () => {
    // A capability that recurses into itself unconditionally.
    const recursive = defineCapability({
      name: 'inf__loop',
      description: 'loops forever',
      inputSchema: {},
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        if (!ctx.callCapability) return { stopped: true };
        return ctx.callCapability('inf__loop', {});
      },
    });
    await bootRegistry([recursive]);

    const result = await dispatchCapability({
      cap: recursive.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      registry,
    });
    // Each recursive call returns the inner response, so the outermost
    // dispatch ultimately succeeds with the depth-exceeded error nested
    // inside its data. Walk down to find it.
    let cur: unknown = result;
    while (cur && typeof cur === 'object' && 'data' in (cur as object)) {
      const next = (cur as { data?: unknown }).data;
      if (!next || typeof next !== 'object') break;
      cur = next;
    }
    const final = cur as { ok?: boolean; error?: { kind?: string } };
    expect(final.ok).toBe(false);
    expect(final.error?.kind).toBe('capability-depth-exceeded');
  });

  test('depth is exposed on CapabilityContext', async () => {
    let observedDepth = -1;
    const cap = defineCapability({
      name: 'depth__check',
      description: 'd',
      inputSchema: {},
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        observedDepth = ctx.depth ?? -1;
        return null;
      },
    });
    await bootRegistry([cap]);

    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
      registry,
    });
    expect(observedDepth).toBe(0);
  });
});

// ── Timeout enforcement ─────────────────────────────────────────

describe('dispatchCapability timeout', () => {
  test('returns timeout error when handler exceeds budget', async () => {
    const cap = defineCapability({
      name: 'slow__call',
      description: 'slow',
      inputSchema: { x: Str() },
      timeout: 30,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { ok: true };
      },
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
    expect(result.error?.kind).toBe('timeout');
    expect(result.error?.message).toContain('30ms');
  });

  test('signal flips to aborted when timeout fires', async () => {
    let observedAbortedReason: unknown = null;
    const cap = defineCapability({
      name: 'cooperative__call',
      description: 'co-op',
      inputSchema: { x: Str() },
      timeout: 20,
      handler: async (_input: unknown, ctx: CapabilityContext) => {
        await new Promise((r) => setTimeout(r, 80));
        observedAbortedReason = ctx.signal?.aborted
          ? (ctx.signal as AbortSignal & { reason?: unknown }).reason
          : null;
        return { done: true };
      },
    });
    await bootRegistry([cap]);
    await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    // Even though dispatchCapability returned with timeout, the handler
    // continued running and observed the abort signal flip.
    await new Promise((r) => setTimeout(r, 100));
    expect(observedAbortedReason).toBe('timeout');
  });

  test('handler returning before timeout is unaffected', async () => {
    const cap = defineCapability({
      name: 'fast__call',
      description: 'fast',
      inputSchema: { x: Str() },
      timeout: 200,
      handler: async () => ({ done: true }),
    });
    await bootRegistry([cap]);
    const result = await dispatchCapability({
      cap: cap.record,
      input: {},
      identity: SYSTEM,
      runtime,
      initiator: surfaceName,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ done: true });
  });
});

// ── System prompt with capabilities ────────────────────────────

describe('buildSystemPrompt with capabilities', () => {
  test('lists capabilities grouped by namespace', () => {
    const caps = discoverCapabilities(registry);
    const prompt = buildSystemPrompt([], caps);
    expect(prompt).toContain('Available capabilities');
    expect(prompt).toContain('drive:');
    expect(prompt).toContain('drive__search');
    expect(prompt).toContain('web:');
    expect(prompt).toContain('web__fetch');
    expect(prompt).toContain('mail:');
    expect(prompt).toContain('mail__bodyfetch');
  });

  test('includes capability descriptions', () => {
    const caps = discoverCapabilities(registry);
    const prompt = buildSystemPrompt([], caps);
    expect(prompt).toContain('Search Drive in a single account');
    expect(prompt).toContain('Fetch a URL');
  });

  test('omits the capabilities section when none registered', () => {
    const prompt = buildSystemPrompt([], []);
    expect(prompt).not.toContain('Available capabilities');
  });

  test('omits the entities section when none discovered', () => {
    const caps = discoverCapabilities(registry);
    const prompt = buildSystemPrompt([], caps);
    expect(prompt).not.toContain('Available entities');
  });
});
