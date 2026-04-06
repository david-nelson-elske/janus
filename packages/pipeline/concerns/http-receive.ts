/**
 * http-receive — Parse HTTP request into dispatch input.
 *
 * Order=5, non-transactional. Runs before schema-parse.
 * Reads transport metadata from ctx.httpRequest (set by the dispatch runtime),
 * merges query → body → params into ctx.parsed alongside any input fields
 * (e.g., lifecycle transition fields injected by the dispatch runtime).
 */

import type { ExecutionHandler } from '@janus/core';

export const httpReceive: ExecutionHandler = async (ctx) => {
  const req = ctx.httpRequest;
  if (!req) {
    // Not an HTTP request — pass through (direct dispatch path)
    return;
  }

  const merged: Record<string, unknown> = {};

  // Preserve fields from input (e.g., lifecycle transition fields
  // injected by the dispatch runtime before pipeline execution)
  const input = ctx.input as Record<string, unknown> | undefined;
  if (input && typeof input === 'object') {
    Object.assign(merged, input);
  }

  // Query params (low priority)
  if (req.query) {
    Object.assign(merged, req.query);
  }

  // Body params (medium priority)
  if (req.body) {
    Object.assign(merged, req.body);
  }

  // Path params (highest priority — id from path overrides body)
  if (req.params) {
    Object.assign(merged, req.params);
  }

  ctx.parsed = merged;
};
