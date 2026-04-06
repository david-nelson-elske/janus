/**
 * dispatch-adapter — Subscription handler that dispatches to another entity.
 *
 * This is how reactions work: when a subscription fires, it dispatches
 * to a target entity:operation via the system initiator.
 *
 * Input resolution:
 * - If config.input is specified → dispatch that (consumer controls the shape)
 * - Otherwise → dispatch notification metadata as _trigger (distinguishable from entity fields)
 *
 * STABLE — ADR 07 subscription adapter.
 */

import type { ExecutionHandler } from '@janus/core';
import { SYSTEM } from '@janus/core';

interface DispatchAdapterConfig {
  readonly entity: string;
  readonly action?: string;
  readonly operation?: string;
  readonly input?: Record<string, unknown>;
}

export const dispatchAdapter: ExecutionHandler = async (ctx) => {
  const config = ctx.config as DispatchAdapterConfig;
  const operation = config.action ?? config.operation ?? 'create';

  if (!ctx._dispatch) {
    throw Object.assign(new Error('dispatch-adapter requires _dispatch on context'), { kind: 'config-error', retryable: false });
  }

  // Resolve dispatch input:
  // 1. Explicit config.input → consumer controls the shape
  // 2. Fallback → notification metadata under _trigger prefix
  const triggerData = ctx.input as Record<string, unknown> | undefined;
  const input = config.input ?? {
    _trigger: triggerData ?? {},
  };

  await ctx._dispatch(config.entity, operation, input, SYSTEM);
};
