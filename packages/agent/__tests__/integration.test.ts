/**
 * Integration tests for Agent Surface — exercises dispatch through agent pipeline end-to-end.
 *
 * Tests: agent dispatch CRUD, identity resolution, interaction level enforcement in response,
 * session entity operations, and tool discovery from a compiled registry.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  define, participate, bind, compile, clearRegistry,
} from '@janus/core';
import type { CompileResult, DispatchResponse, Identity } from '@janus/core';
import { Str, Int, Lifecycle, Persistent, Sensitive as SensitiveClassification } from '@janus/vocabulary';
import {
  registerHandlers, createDispatchRuntime, createBroker,
  frameworkEntities, frameworkParticipations,
} from '@janus/pipeline';
import type { DispatchRuntime, Broker } from '@janus/pipeline';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import type { EntityStore } from '@janus/store';
import { agentSurface } from '..';
import type { AgentResponse } from '../types';

// ── Test fixtures ──────────────────────────────────────────────

const DetailComponent = () => {};

const agentIdentity: Identity = { id: 'agent-1', roles: ['assistant'] };
let registry: CompileResult;
let runtime: DispatchRuntime;
let store: EntityStore;
let broker: Broker;
let surfaceName: string;

beforeEach(async () => {
  clearRegistry();
  registerHandlers();

  // note entity with bindings
  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      body: Str(),
      priority: Int(),
      status: Lifecycle({ draft: ['published'], published: ['archived'] }),
    },
    storage: Persistent(),
  });

  const noteP = participate(note, {});

  const noteBinding = bind(note, [
    {
      component: DetailComponent,
      view: 'detail',
      config: {
        fields: {
          title: { agent: 'read-write', component: 'heading' },
          body: { agent: 'read-write', component: 'richtext' },
          priority: { agent: 'read', component: 'badge' },
          status: { agent: 'read', component: 'badge' },
        },
      },
    },
  ]);

  // secret entity — Sensitive classification, with aware-level binding
  const secret = define('secret', {
    schema: SensitiveClassification({
      label: Str({ required: true }),
      pin: Str({ required: true }),
    }),
    storage: Persistent(),
  });

  const secretP = participate(secret, {});

  const secretBinding = bind(secret, [
    {
      component: DetailComponent,
      view: 'detail',
      config: {
        fields: {
          label: { agent: 'read', component: 'text' },
          pin: { agent: 'aware', component: 'text' },
        },
      },
    },
  ]);

  const surface = agentSurface({
    identity: {
      agents: {
        'agent-1': agentIdentity,
      },
    },
  });

  surfaceName = surface.initiator.name;

  // Note: surface.definition (agent_session) is already in frameworkEntities,
  // so we don't include it again here.
  registry = compile(
    [
      note, noteP, noteBinding,
      secret, secretP, secretBinding,
      ...frameworkEntities,
      ...frameworkParticipations,
    ],
    [surface.initiator],
  );

  const memoryAdapter = createMemoryAdapter();

  store = createEntityStore({
    routing: registry.persistRouting,
    adapters: {
      relational: memoryAdapter,
      memory: memoryAdapter,
    },
  });

  await store.initialize();

  broker = createBroker();
  runtime = createDispatchRuntime({ registry, store, broker });
});

afterEach(() => {
  clearRegistry();
});

// ── Helpers ────────────────────────────────────────────────────

function agentDispatch(
  entity: string,
  operation: string,
  params?: Record<string, unknown>,
  agentId = 'agent-1',
): Promise<DispatchResponse> {
  return runtime.dispatch(
    surfaceName,
    entity,
    operation,
    {},
    undefined,
    { agentRequest: { agentId, parameters: params } },
  );
}

function getAgentResponse(response: DispatchResponse): AgentResponse {
  return response.extensions?.agentResponse as AgentResponse;
}

// ── CRUD through agent surface ─────────────────────────────────

describe('Agent CRUD', () => {
  test('create via agent dispatch produces agentResponse', async () => {
    const res = await agentDispatch('note', 'create', { title: 'Agent note', body: 'Created by agent' });
    expect(res.ok).toBe(true);

    const agentRes = getAgentResponse(res);
    expect(agentRes).toBeDefined();
    expect(agentRes.ok).toBe(true);
    expect((agentRes.data as any).title).toBe('Agent note');
    expect(agentRes.meta?.entity).toBe('note');
    expect(agentRes.meta?.operation).toBe('create');
  });

  test('read via agent dispatch returns data with interaction-level metadata', async () => {
    // Create first
    const createRes = await agentDispatch('note', 'create', { title: 'Read test' });
    const id = (createRes.data as any).id;

    // Read
    const readRes = await agentDispatch('note', 'read', { id });
    expect(readRes.ok).toBe(true);

    const agentRes = getAgentResponse(readRes);
    expect(agentRes.ok).toBe(true);
    expect(agentRes.meta?.interactionLevels).toBeDefined();
    expect(agentRes.meta!.interactionLevels.title).toBe('read-write');
    expect(agentRes.meta!.interactionLevels.priority).toBe('read');
  });

  test('update via agent dispatch works', async () => {
    const createRes = await agentDispatch('note', 'create', { title: 'Update me' });
    const id = (createRes.data as any).id;

    const updateRes = await agentDispatch('note', 'update', { id, title: 'Updated' });
    expect(updateRes.ok).toBe(true);

    const agentRes = getAgentResponse(updateRes);
    expect(agentRes.ok).toBe(true);
    expect((agentRes.data as any).title).toBe('Updated');
  });

  test('delete via agent dispatch returns response', async () => {
    const createRes = await agentDispatch('note', 'create', { title: 'Delete me' });
    const id = (createRes.data as any).id;

    const deleteRes = await agentDispatch('note', 'delete', { id });
    expect(deleteRes.ok).toBe(true);

    const agentRes = getAgentResponse(deleteRes);
    expect(agentRes.ok).toBe(true);
  });

  test('list via agent dispatch returns page', async () => {
    await agentDispatch('note', 'create', { title: 'Note 1' });
    await agentDispatch('note', 'create', { title: 'Note 2' });

    const listRes = await agentDispatch('note', 'read');
    expect(listRes.ok).toBe(true);

    const agentRes = getAgentResponse(listRes);
    expect(agentRes.ok).toBe(true);
    expect(agentRes.meta?.entity).toBe('note');
  });
});

// ── Identity resolution ────────────────────────────────────────

describe('Agent identity', () => {
  test('known agentId resolves to configured identity', async () => {
    const res = await agentDispatch('note', 'create', { title: 'By known agent' }, 'agent-1');
    expect(res.ok).toBe(true);
    // The identity should be resolved — createdBy will show the agent id
    expect((res.data as any).createdBy).toBe('agent-1');
  });

  test('unknown agentId resolves to anonymous', async () => {
    const res = await agentDispatch('note', 'create', { title: 'By unknown agent' }, 'unknown-agent');
    expect(res.ok).toBe(true);
    expect((res.data as any).createdBy).toBe('anonymous');
  });
});

// ── Interaction level enforcement in response ──────────────────

describe('Interaction levels in response', () => {
  test('read-write fields appear with full values', async () => {
    const createRes = await agentDispatch('note', 'create', { title: 'Visible', body: 'Full text' });
    const id = (createRes.data as any).id;

    const readRes = await agentDispatch('note', 'read', { id });
    const agentRes = getAgentResponse(readRes);

    expect((agentRes.data as any).title).toBe('Visible');
    expect((agentRes.data as any).body).toBe('Full text');
  });

  test('read fields appear with values in metadata', async () => {
    const createRes = await agentDispatch('note', 'create', { title: 'Test', priority: 5 });
    const id = (createRes.data as any).id;

    const readRes = await agentDispatch('note', 'read', { id });
    const agentRes = getAgentResponse(readRes);

    expect(agentRes.meta!.interactionLevels.priority).toBe('read');
    expect((agentRes.data as any).priority).toBe(5);
  });

  test('aware fields are redacted in response', async () => {
    const createRes = await agentDispatch('secret', 'create', { label: 'My secret', pin: '1234' });
    const id = (createRes.data as any).id;

    const readRes = await agentDispatch('secret', 'read', { id });
    const agentRes = getAgentResponse(readRes);

    // label is 'read' — visible
    expect((agentRes.data as any).label).toBe('My secret');
    // pin is 'aware' — redacted
    expect((agentRes.data as any).pin).toBe('[redacted]');
    expect(agentRes.meta!.interactionLevels.pin).toBe('aware');
  });

  test('response includes interactionLevels map', async () => {
    const createRes = await agentDispatch('note', 'create', { title: 'Levels test' });
    const agentRes = getAgentResponse(createRes);

    expect(agentRes.meta?.interactionLevels).toBeDefined();
    expect(agentRes.meta!.interactionLevels.title).toBe('read-write');
    expect(agentRes.meta!.interactionLevels.status).toBe('read');
  });
});

// ── Session entity ─────────────────────────────────────────────

describe('Session entity', () => {
  test('agent_session entity is compiled', () => {
    const node = registry.entity('agent_session');
    expect(node).toBeDefined();
    expect(node!.origin).toBe('framework');
  });

  test('agent_session has correct schema fields', () => {
    const node = registry.entity('agent_session');
    expect(node).toBeDefined();
    expect(node!.schema).toHaveProperty('agent_id');
    expect(node!.schema).toHaveProperty('user_id');
    expect(node!.schema).toHaveProperty('url');
    expect(node!.schema).toHaveProperty('active_bindings');
    expect(node!.schema).toHaveProperty('last_activity');
  });
});
