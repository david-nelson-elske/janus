/**
 * Tests for deriveInteractionLevels(), discoverTools(), and buildAgentContext().
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  define, participate, bind, compile, clearRegistry,
} from '@janus/core';
import type { CompileResult } from '@janus/core';
import { Str, Int, Lifecycle, Persistent, Sensitive } from '@janus/vocabulary';
import { registerHandlers, frameworkEntities, frameworkParticipations } from '@janus/pipeline';
import { agentSurface, deriveInteractionLevels, discoverTools, buildAgentContext } from '..';
import type { SessionRecord } from '..';

// ── Shared setup ───────────────────────────────────────────────

const DetailComponent = () => {};
const ListComponent = () => {};

let registry: CompileResult;
let initiatorName: string;

beforeEach(() => {
  clearRegistry();
  registerHandlers();

  // note entity — Public classification, with bindings
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
          title: { agent: 'read-write', component: 'heading', label: 'Title' },
          body: { agent: 'read-write', component: 'richtext' },
          priority: { agent: 'read', component: 'badge' },
          status: { agent: 'read', component: 'badge' },
        },
      },
    },
    {
      component: ListComponent,
      view: 'list',
      config: {
        columns: ['title', 'status'],
        fields: {
          title: { agent: 'read', component: 'text' },
          status: { agent: 'read', component: 'badge' },
        },
      },
    },
  ]);

  // secret entity — Sensitive classification, no bindings
  const secret = define('secret', {
    schema: Sensitive({
      content: Str({ required: true }),
      pin: Str({ required: true }),
    }),
    storage: Persistent(),
  });

  const secretP = participate(secret, {});

  const surface = agentSurface({
    identity: {
      agents: { 'agent-1': { id: 'agent-1', roles: ['assistant'] } },
    },
  });

  initiatorName = surface.initiator.name;

  // Note: surface.definition (agent_session) is already in frameworkEntities,
  // so we don't include it again here.
  registry = compile(
    [
      note, noteP, noteBinding,
      secret, secretP,
      ...frameworkEntities,
      ...frameworkParticipations,
    ],
    [surface.initiator],
  );
});

afterEach(() => {
  clearRegistry();
});

// ── deriveInteractionLevels ────────────────────────────────────

describe('deriveInteractionLevels', () => {
  test('returns empty for unknown entity', () => {
    const levels = deriveInteractionLevels(registry, 'nonexistent');
    expect(Object.keys(levels)).toHaveLength(0);
  });

  test('derives read-write for Public entity fields (default)', () => {
    // note is Public (default) → open → read-write base
    // But bindings override, so test on a field NOT in binding
    const levels = deriveInteractionLevels(registry, 'note');
    // priority is in binding as 'read', title as 'read-write'
    expect(levels.title).toBe('read-write');
    expect(levels.body).toBe('read-write');
    expect(levels.priority).toBe('read');
    expect(levels.status).toBe('read');
  });

  test('derives aware for Sensitive entity fields', () => {
    const levels = deriveInteractionLevels(registry, 'secret');
    expect(levels.content).toBe('aware');
    expect(levels.pin).toBe('aware');
  });

  test('binding config overrides sensitivity default', () => {
    // note is Public (read-write default) but priority overridden to 'read'
    const levels = deriveInteractionLevels(registry, 'note');
    expect(levels.priority).toBe('read');
  });

  test('view-specific binding lookup works', () => {
    // list view has title as 'read', detail view has title as 'read-write'
    const listLevels = deriveInteractionLevels(registry, 'note', 'list');
    expect(listLevels.title).toBe('read');

    const detailLevels = deriveInteractionLevels(registry, 'note', 'detail');
    expect(detailLevels.title).toBe('read-write');
  });

  test('unbound fields get the sensitivity default', () => {
    // secret has no bindings → all fields get restricted → aware
    const levels = deriveInteractionLevels(registry, 'secret');
    expect(levels.content).toBe('aware');
  });

  test('result is frozen', () => {
    const levels = deriveInteractionLevels(registry, 'note');
    expect(Object.isFrozen(levels)).toBe(true);
  });
});

// ── discoverTools ──────────────────────────────────────────────

describe('discoverTools', () => {
  test('returns ToolDescriptor for each consumer entity operation', () => {
    const tools = discoverTools(registry, initiatorName);
    const noteTools = tools.filter((t) => t.entity === 'note');
    // note has read, create, update, delete operations
    expect(noteTools.length).toBeGreaterThanOrEqual(4);
  });

  test('skips framework-origin entities', () => {
    const tools = discoverTools(registry, initiatorName);
    const frameworkTools = tools.filter(
      (t) => t.entity === 'execution_log' || t.entity === 'agent_session',
    );
    expect(frameworkTools).toHaveLength(0);
  });

  test('each descriptor includes entity name and operation', () => {
    const tools = discoverTools(registry, initiatorName);
    for (const tool of tools) {
      expect(tool.entity).toBeDefined();
      expect(tool.operation).toBeDefined();
    }
  });

  test('field descriptors include interaction levels from bindings', () => {
    const tools = discoverTools(registry, initiatorName);
    const noteRead = tools.find((t) => t.entity === 'note' && t.operation === 'read');
    expect(noteRead).toBeDefined();

    const titleField = noteRead!.fields.find((f) => f.name === 'title');
    expect(titleField).toBeDefined();
    expect(titleField!.interactionLevel).toBe('read-write');

    const priorityField = noteRead!.fields.find((f) => f.name === 'priority');
    expect(priorityField).toBeDefined();
    expect(priorityField!.interactionLevel).toBe('read');
  });

  test('lifecycle transitions appear in transitions array', () => {
    const tools = discoverTools(registry, initiatorName);
    const noteCreate = tools.find((t) => t.entity === 'note' && t.operation === 'create');
    expect(noteCreate).toBeDefined();
    // Transitions are on the entity, not per-operation, but should appear on at least one tool
    const anyWithTransitions = tools.filter((t) => t.entity === 'note' && t.transitions && t.transitions.length > 0);
    expect(anyWithTransitions.length).toBeGreaterThan(0);
    const transitions = anyWithTransitions[0].transitions!;
    expect(transitions).toContain('published');
    expect(transitions).toContain('archived');
  });

  test('returns empty array for nonexistent initiator', () => {
    const tools = discoverTools(registry, 'nonexistent');
    expect(tools).toHaveLength(0);
  });

  test('result is frozen', () => {
    const tools = discoverTools(registry, initiatorName);
    expect(Object.isFrozen(tools)).toBe(true);
  });
});

// ── buildAgentContext ──────────────────────────────────────────

describe('buildAgentContext', () => {
  test('builds context from session record', () => {
    const session: SessionRecord = {
      id: 'session-1',
      agent_id: 'agent-1',
      user_id: 'user-1',
      url: '/notes/123',
      latest_binding_entity: 'note',
      latest_binding_view: 'detail',
      active_bindings: [
        { entity: 'note', view: 'detail' },
      ],
      last_activity: new Date().toISOString(),
    };

    const ctx = buildAgentContext({ registry, session, initiator: initiatorName });
    expect(ctx.session).toBe(session);
    expect(ctx.focusedEntity).toBeDefined();
    expect(ctx.focusedEntity!.entity).toBe('note');
    expect(ctx.focusedEntity!.view).toBe('detail');
  });

  test('focused entity includes operations and field access', () => {
    const session: SessionRecord = {
      id: 'session-1',
      agent_id: 'agent-1',
      user_id: 'user-1',
      latest_binding_entity: 'note',
      latest_binding_view: 'detail',
      last_activity: new Date().toISOString(),
    };

    const ctx = buildAgentContext({ registry, session, initiator: initiatorName });
    expect(ctx.focusedEntity!.operations).toContain('read');
    expect(ctx.focusedEntity!.operations).toContain('create');
    expect(ctx.focusedEntity!.fieldAccess.title).toBe('read-write');
    expect(ctx.focusedEntity!.fieldAccess.priority).toBe('read');
  });

  test('active bindings include per-field levels', () => {
    const session: SessionRecord = {
      id: 'session-1',
      agent_id: 'agent-1',
      user_id: 'user-1',
      active_bindings: [
        { entity: 'note', view: 'list' },
      ],
      last_activity: new Date().toISOString(),
    };

    const ctx = buildAgentContext({ registry, session, initiator: initiatorName });
    expect(ctx.activeBindings).toHaveLength(1);
    expect(ctx.activeBindings[0].entity).toBe('note');
    expect(ctx.activeBindings[0].view).toBe('list');
    // list view has title as 'read'
    expect(ctx.activeBindings[0].fieldAccess.title).toBe('read');
  });

  test('handles missing binding data gracefully', () => {
    const session: SessionRecord = {
      id: 'session-1',
      agent_id: 'agent-1',
      user_id: 'user-1',
      last_activity: new Date().toISOString(),
    };

    const ctx = buildAgentContext({ registry, session, initiator: initiatorName });
    expect(ctx.focusedEntity).toBeUndefined();
    expect(ctx.activeBindings).toHaveLength(0);
  });

  test('result is frozen', () => {
    const session: SessionRecord = {
      id: 'session-1',
      agent_id: 'agent-1',
      user_id: 'user-1',
      last_activity: new Date().toISOString(),
    };

    const ctx = buildAgentContext({ registry, session, initiator: initiatorName });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.activeBindings)).toBe(true);
  });
});
