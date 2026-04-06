/**
 * agentSurface() — Produces a session entity definition + InitiatorConfig
 * with agent transport participation records.
 *
 * The initiator's participations (agent-receive, agent-identity, agent-respond)
 * join with each entity's participations at compile time to produce complete
 * agent pipelines. Follows the same pattern as apiSurface() for HTTP.
 */

import type { InitiatorConfig, ParticipationRecord, DefineResult } from '@janus/core';
import { agentSession } from '@janus/pipeline';
import type { AgentSurfaceConfig } from './types';

/**
 * Create an agent surface initiator for AI model dispatch.
 *
 * Returns the session entity definition (for introspection — it's already
 * included in frameworkEntities) and the initiator config (to pass as an
 * initiator to compile).
 */
export function agentSurface(config?: AgentSurfaceConfig): {
  readonly definition: DefineResult;
  readonly initiator: InitiatorConfig;
} {
  const name = config?.name ?? 'agent-surface';

  const participations: ParticipationRecord[] = [
    {
      source: name,
      handler: 'agent-receive',
      order: 5,
      transactional: false,
      config: {},
    },
    {
      source: name,
      handler: 'agent-identity',
      order: 6,
      transactional: false,
      config: { agents: config?.identity?.agents ?? {} },
    },
    {
      source: name,
      handler: 'agent-respond',
      order: 80,
      transactional: false,
      config: {},
    },
  ];

  return {
    definition: agentSession,
    initiator: {
      name,
      origin: 'consumer',
      participations,
    },
  };
}
