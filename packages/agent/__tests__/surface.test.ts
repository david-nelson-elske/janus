/**
 * Tests for agentSurface() constructor.
 */

import { describe, expect, test } from 'bun:test';
import { agentSurface } from '..';

describe('agentSurface', () => {
  test('returns default name', () => {
    const s = agentSurface();
    expect(s.initiator.name).toBe('agent-surface');
  });

  test('respects custom name', () => {
    const s = agentSurface({ name: 'my-agent' });
    expect(s.initiator.name).toBe('my-agent');
  });

  test('produces three participation records', () => {
    const s = agentSurface();
    expect(s.initiator.participations).toHaveLength(3);

    const handlers = s.initiator.participations!.map((p) => p.handler);
    expect(handlers).toContain('agent-receive');
    expect(handlers).toContain('agent-identity');
    expect(handlers).toContain('agent-respond');
  });

  test('participation orders are correct', () => {
    const s = agentSurface();
    const byHandler = Object.fromEntries(
      s.initiator.participations!.map((p) => [p.handler, p]),
    );
    expect(byHandler['agent-receive'].order).toBe(5);
    expect(byHandler['agent-identity'].order).toBe(6);
    expect(byHandler['agent-respond'].order).toBe(80);
  });

  test('all participations are non-transactional', () => {
    const s = agentSurface();
    for (const p of s.initiator.participations!) {
      expect(p.transactional).toBe(false);
    }
  });

  test('passes agent identity config to agent-identity config', () => {
    const agents = { 'agent-1': { id: 'agent-1', roles: ['assistant'] as readonly string[] } };
    const s = agentSurface({ identity: { agents } });
    const identityP = s.initiator.participations!.find((p) => p.handler === 'agent-identity')!;
    expect((identityP.config as any).agents).toBe(agents);
  });

  test('origin is consumer', () => {
    const s = agentSurface();
    expect(s.initiator.origin).toBe('consumer');
  });

  test('returns a definition (session entity)', () => {
    const s = agentSurface();
    expect(s.definition).toBeDefined();
    expect(s.definition.kind).toBe('define');
    expect(s.definition.record.name).toBe('agent_session');
  });
});
