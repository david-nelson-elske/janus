/**
 * agent-receive — Parse agent tool call into dispatch input.
 *
 * Order=5, non-transactional. Runs before schema-parse.
 * Reads transport metadata from ctx.agentRequest (set by the dispatch runtime),
 * merges existing input + parameters into ctx.parsed.
 */

import type { ExecutionHandler } from '@janus/core';

export const agentReceive: ExecutionHandler = async (ctx) => {
  const req = ctx.agentRequest;
  if (!req) {
    // Not an agent request — pass through (direct dispatch path)
    return;
  }

  const merged: Record<string, unknown> = {};

  // Preserve fields from input (e.g., lifecycle transition fields
  // injected by the dispatch runtime before pipeline execution)
  const input = ctx.input as Record<string, unknown> | undefined;
  if (input && typeof input === 'object') {
    Object.assign(merged, input);
  }

  // Tool call parameters (override input)
  if (req.parameters) {
    Object.assign(merged, req.parameters);
  }

  ctx.parsed = merged;
};
