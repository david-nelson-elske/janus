/**
 * declareAgentSurface + validateAgentSurfaces — M4 phase 0 plumbing.
 *
 * Spec: `.planning/AGENT-INTROSPECTION.md` §5, §11 phase 0.
 */

import { describe, it, expect } from 'bun:test';
import {
  declareAgentSurface,
  validateAgentSurfaces,
  type AgentSurfaceRegistry,
  type ValidationRegistries,
} from '../declare-surface';

// Test fixtures — minimal shapes that match the structural
// interfaces the validator reads.
const fixtureChannel = {
  name: 'decision-updated',
  payload: {},
  scope: {},
  publishers: [],
  subscribers: [],
  persist: 'transient' as const,
} as unknown as ValidationRegistries['channels'][string];

const fixtureProjection = {
  name: 'decision-doc-view',
  selector: {} as never,
} as unknown as ValidationRegistries['projections'][string];

const fixtureController = {
  name: 'decision-doc',
  invokable: {
    highlightSection: { allowedActors: ['agent-surface'] },
    privateAction: { allowedActors: ['controller'] },
  },
};

const baseRegistries: ValidationRegistries = {
  projections: { 'decision-doc-view': fixtureProjection },
  channels: { 'decision-updated': fixtureChannel },
  controllers: { 'decision-doc': fixtureController },
};

describe('declareAgentSurface', () => {
  it('returns the input unchanged (pure data)', () => {
    const decl = declareAgentSurface({
      name: 'test',
      role: 'agent-surface',
      runtime: 'chat-bound',
      reads: [],
      subscribes: [],
      invokes: [],
      audit: 'all',
    });
    expect(decl.name).toBe('test');
    expect(decl.runtime).toBe('chat-bound');
  });
});

describe('validateAgentSurfaces', () => {
  it('passes a well-formed surface', () => {
    const surfaces: AgentSurfaceRegistry = {
      'chat-agent': declareAgentSurface({
        name: 'chat-agent',
        role: 'agent-surface',
        runtime: 'chat-bound',
        reads: ['decision-doc-view'],
        subscribes: [{ channel: 'decision-updated', scope: { decisionId: 'ctx.decisionId' } }],
        invokes: [{ controller: 'decision-doc', action: 'highlightSection' }],
        audit: 'all',
      }),
    };
    expect(() => validateAgentSurfaces(surfaces, baseRegistries)).not.toThrow();
  });

  it('rejects an unknown projection in reads', () => {
    const surfaces: AgentSurfaceRegistry = {
      'chat-agent': declareAgentSurface({
        name: 'chat-agent',
        role: 'agent-surface',
        runtime: 'chat-bound',
        reads: ['no-such-projection'],
        subscribes: [],
        invokes: [],
        audit: 'all',
      }),
    };
    expect(() => validateAgentSurfaces(surfaces, baseRegistries)).toThrow(
      /reads unknown projection "no-such-projection"/,
    );
  });

  it('rejects an unknown channel in subscribes', () => {
    const surfaces: AgentSurfaceRegistry = {
      'chat-agent': declareAgentSurface({
        name: 'chat-agent',
        role: 'agent-surface',
        runtime: 'chat-bound',
        reads: [],
        subscribes: [{ channel: 'no-such-channel', scope: {} }],
        invokes: [],
        audit: 'all',
      }),
    };
    expect(() => validateAgentSurfaces(surfaces, baseRegistries)).toThrow(
      /subscribes to unknown channel "no-such-channel"/,
    );
  });

  it('rejects an unknown controller in invokes', () => {
    const surfaces: AgentSurfaceRegistry = {
      'chat-agent': declareAgentSurface({
        name: 'chat-agent',
        role: 'agent-surface',
        runtime: 'chat-bound',
        reads: [],
        subscribes: [],
        invokes: [{ controller: 'no-such', action: 'anything' }],
        audit: 'all',
      }),
    };
    expect(() => validateAgentSurfaces(surfaces, baseRegistries)).toThrow(
      /invokes on unknown controller "no-such"/,
    );
  });

  it('rejects an unknown action on a known controller', () => {
    const surfaces: AgentSurfaceRegistry = {
      'chat-agent': declareAgentSurface({
        name: 'chat-agent',
        role: 'agent-surface',
        runtime: 'chat-bound',
        reads: [],
        subscribes: [],
        invokes: [{ controller: 'decision-doc', action: 'doesntExist' }],
        audit: 'all',
      }),
    };
    expect(() => validateAgentSurfaces(surfaces, baseRegistries)).toThrow(
      /no invokable action "doesntExist"/,
    );
  });

  it("rejects an action whose allowedActors doesn't admit the surface's role", () => {
    const surfaces: AgentSurfaceRegistry = {
      'chat-agent': declareAgentSurface({
        name: 'chat-agent',
        role: 'agent-surface',
        runtime: 'chat-bound',
        reads: [],
        subscribes: [],
        invokes: [{ controller: 'decision-doc', action: 'privateAction' }],
        audit: 'all',
      }),
    };
    expect(() => validateAgentSurfaces(surfaces, baseRegistries)).toThrow(
      /doesn't list "agent-surface" or "agent-surface" in allowedActors/,
    );
  });

  it('rejects registry key/name mismatch', () => {
    const surfaces: AgentSurfaceRegistry = {
      'mismatched-key': declareAgentSurface({
        name: 'declaration-name',
        role: 'agent-surface',
        runtime: 'chat-bound',
        reads: [],
        subscribes: [],
        invokes: [],
        audit: 'all',
      }),
    };
    expect(() => validateAgentSurfaces(surfaces, baseRegistries)).toThrow(
      /registry key does not match declaration name/,
    );
  });
});
