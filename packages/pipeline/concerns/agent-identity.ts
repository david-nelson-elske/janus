/**
 * agent-identity — Resolve agent identity from request context.
 *
 * Order=6, non-transactional. Reads ctx.agentRequest.agentId,
 * looks up the agent in a config-provided map, and sets identity on the context.
 */

import type { ExecutionHandler, Identity } from '@janus/core';
import { ANONYMOUS, setIdentity } from '@janus/core';

interface AgentIdentityConfig {
  readonly agents?: Readonly<Record<string, Identity>>;
}

export const agentIdentity: ExecutionHandler = async (ctx) => {
  const agentReq = ctx.agentRequest;
  if (!agentReq) {
    return;
  }

  const config = ctx.config as unknown as AgentIdentityConfig;
  const resolved = config?.agents?.[agentReq.agentId];
  if (resolved) {
    setIdentity(ctx, resolved);
    return;
  }

  setIdentity(ctx, ANONYMOUS);
};
