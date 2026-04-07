/**
 * Tests for OpenAI Realtime tool conversion and navigation tool generation.
 */

import { describe, expect, test } from 'bun:test';
import { toOpenAIRealtimeTools, navigationToOpenAIRealtimeTools } from '..';
import type { ToolDescriptor, NavigationDescriptor } from '..';

// ── toOpenAIRealtimeTools ─────────────────────────────────────

describe('toOpenAIRealtimeTools', () => {
  const tools: readonly ToolDescriptor[] = [
    {
      entity: 'task',
      operation: 'read',
      description: 'A work item',
      fields: [
        { name: 'id', type: 'str', required: false, interactionLevel: 'read-write' },
        { name: 'title', type: 'str', required: true, interactionLevel: 'read-write' },
        { name: 'pin', type: 'str', required: false, interactionLevel: 'aware' },
      ],
      transitions: ['completed', 'archived'],
    },
  ];

  test('produces function tools with entity__operation name', () => {
    const result = toOpenAIRealtimeTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('function');
    expect(result[0].name).toBe('task__read');
  });

  test('description includes entity description and transitions', () => {
    const result = toOpenAIRealtimeTools(tools);
    expect(result[0].description).toContain('A work item');
    expect(result[0].description).toContain('completed');
    expect(result[0].description).toContain('archived');
  });

  test('excludes aware-level fields from parameters', () => {
    const result = toOpenAIRealtimeTools(tools);
    const props = result[0].parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('id');
    expect(props).toHaveProperty('title');
    expect(props).not.toHaveProperty('pin');
  });

  test('marks required fields', () => {
    const result = toOpenAIRealtimeTools(tools);
    expect(result[0].parameters.required).toEqual(['title']);
  });
});

// ── navigationToOpenAIRealtimeTools ───────────────────────────

describe('navigationToOpenAIRealtimeTools', () => {
  const navTools: readonly NavigationDescriptor[] = [
    { entity: 'task', view: 'list', path: '/tasks', label: 'Task list', requiresId: false },
    { entity: 'task', view: 'detail', path: '/tasks/:id', label: 'Task detail', requiresId: true },
  ];

  test('produces navigate__entity__view named tools', () => {
    const result = navigationToOpenAIRealtimeTools(navTools);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('navigate__task__list');
    expect(result[1].name).toBe('navigate__task__detail');
  });

  test('list tool has no required parameters', () => {
    const result = navigationToOpenAIRealtimeTools(navTools);
    const listTool = result[0];
    expect(listTool.parameters.required).toBeUndefined();
    expect(Object.keys(listTool.parameters.properties as object)).toHaveLength(0);
  });

  test('detail tool requires id parameter', () => {
    const result = navigationToOpenAIRealtimeTools(navTools);
    const detailTool = result[1];
    expect(detailTool.parameters.required).toEqual(['id']);
    const props = detailTool.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.id.type).toBe('string');
  });

  test('description references the label', () => {
    const result = navigationToOpenAIRealtimeTools(navTools);
    expect(result[0].description).toBe('Navigate to the Task list view');
    expect(result[1].description).toBe('Navigate to the Task detail view');
  });
});
