/**
 * rate-limit-check — Counter check against in-memory sliding window (ADR 05).
 *
 * Reads { max, window } from ctx.config (wired via participate({ rateLimit })).
 * Builds key from entity + identity. Checks/increments counter.
 * Throws with kind='rate-limit-exceeded' when the limit is hit.
 */

import type { ExecutionHandler } from '@janus/core';
import type { RateLimitStore } from '../rate-limit-store';

interface RateLimitHandlerConfig {
  readonly max: number;
  readonly window: number;
}

/**
 * Create a rate-limit-check handler backed by the given store.
 */
export function createRateLimitCheck(store: RateLimitStore): ExecutionHandler {
  return async (ctx) => {
    const config = ctx.config as unknown as RateLimitHandlerConfig;
    if (!config || !config.max || !config.window) return;

    const key = `${ctx.entity}:${ctx.identity.id}`;
    const result = store.check(key, config.max, config.window);

    if (result.blocked) {
      throw Object.assign(
        new Error(
          `Rate limit exceeded for ${ctx.identity.id} on ${ctx.entity}: ` +
          `${result.count}/${config.max} in ${config.window}ms window`,
        ),
        {
          kind: 'rate-limit-exceeded' as const,
          retryable: true,
          retryAfterMs: result.retryAfterMs,
        },
      );
    }
  };
}
