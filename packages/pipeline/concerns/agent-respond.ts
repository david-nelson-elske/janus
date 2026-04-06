/**
 * agent-respond — Shape dispatch result into agent tool response.
 *
 * Order=80, non-transactional (postTx). Writes to ctx.extensions.agentResponse
 * so the caller can read the shaped response from DispatchResponse.extensions.
 *
 * Uses binding metadata and interaction levels to shape output:
 * - read-write fields: full value included
 * - read fields: full value included, marked read-only
 * - aware fields: field name + type visible, value omitted
 */

import type { AgentInteractionLevel, ExecutionHandler } from '@janus/core';
import { extractResultData } from '@janus/core';
import { deriveInteractionLevels } from '../../agent/context';
import type { AgentResponse } from '../../agent/types';

function filterByInteractionLevels(
  data: unknown,
  levels: Readonly<Record<string, AgentInteractionLevel>>,
): unknown {
  if (!data || typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => filterByInteractionLevels(item, levels));
  }

  const record = data as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const level = levels[key];
    if (level === 'aware') {
      filtered[key] = '[redacted]';
    } else {
      filtered[key] = value;
    }
  }

  return filtered;
}

export const agentRespond: ExecutionHandler = async (ctx) => {
  if (!ctx.extensions) ctx.extensions = {};

  if (ctx.error) {
    const response: AgentResponse = {
      ok: false,
      error: { kind: ctx.error.kind, message: ctx.error.message },
    };
    ctx.extensions.agentResponse = response;
    return;
  }

  const data = extractResultData(ctx.result);
  const levels = deriveInteractionLevels(ctx.registry, ctx.entity);
  const filtered = filterByInteractionLevels(data, levels);

  const response: AgentResponse = {
    ok: true,
    data: filtered,
    meta: {
      entity: ctx.entity,
      operation: ctx.operation,
      interactionLevels: levels,
    },
  };

  ctx.extensions.agentResponse = response;
};
