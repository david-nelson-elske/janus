/**
 * Unit tests for buildContext — the pipeline context builder.
 *
 * Exercises: required fields, startedAt, config initialization,
 * optional fields presence/absence.
 */

import { describe, expect, test } from 'bun:test';
import { buildContext } from '..';

// Minimal mocks for store and registry
const mockStore = { initialize: async () => {} } as any;
const mockRegistry = { entities: new Map() } as any;
const mockIdentity = { id: 'user-1', roles: ['admin'] };

function minimalArgs() {
  return {
    correlationId: 'corr-1',
    traceId: 'trace-1',
    identity: mockIdentity,
    entity: 'note',
    operation: 'create' as const,
    input: { title: 'Test' },
    depth: 0,
    store: mockStore,
    registry: mockRegistry,
  };
}

describe('buildContext()', () => {
  test('returns all required fields', () => {
    const ctx = buildContext(minimalArgs());

    expect(ctx.correlationId).toBe('corr-1');
    expect(ctx.traceId).toBe('trace-1');
    expect(ctx.identity).toEqual(mockIdentity);
    expect(ctx.entity).toBe('note');
    expect(ctx.operation).toBe('create');
    expect(ctx.input).toEqual({ title: 'Test' });
    expect(ctx.depth).toBe(0);
    expect(ctx.store).toBe(mockStore);
    expect(ctx.registry).toBe(mockRegistry);
  });

  test('sets startedAt from performance.now()', () => {
    const before = performance.now();
    const ctx = buildContext(minimalArgs());
    const after = performance.now();

    expect(ctx.startedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.startedAt).toBeLessThanOrEqual(after);
  });

  test('initializes config as empty object', () => {
    const ctx = buildContext(minimalArgs());
    expect(ctx.config).toEqual({});
  });

  test('optional fields included when provided', () => {
    const mockBroker = { notify: () => {}, onNotify: () => () => {} } as any;
    const mockAssetBackend = { write: async () => ({}), url: () => '', delete: async () => {}, read: async () => new Uint8Array() } as any;
    const mockHttpRequest = { method: 'GET', path: '/', headers: {} } as any;
    const mockAgentRequest = { sessionId: 'sess-1' } as any;
    const mockDispatch = async () => ({}) as any;

    const ctx = buildContext({
      ...minimalArgs(),
      broker: mockBroker,
      assetBackend: mockAssetBackend,
      httpRequest: mockHttpRequest,
      agentRequest: mockAgentRequest,
      _dispatch: mockDispatch,
    });

    expect(ctx.broker).toBe(mockBroker);
    expect(ctx.assetBackend).toBe(mockAssetBackend);
    expect(ctx.httpRequest).toBe(mockHttpRequest);
    expect(ctx.agentRequest).toBe(mockAgentRequest);
    expect(ctx._dispatch).toBe(mockDispatch);
  });

  test('optional fields undefined when not provided', () => {
    const ctx = buildContext(minimalArgs());

    expect(ctx.broker).toBeUndefined();
    expect(ctx.assetBackend).toBeUndefined();
    expect(ctx.httpRequest).toBeUndefined();
    expect(ctx.agentRequest).toBeUndefined();
    expect(ctx._dispatch).toBeUndefined();
  });
});
