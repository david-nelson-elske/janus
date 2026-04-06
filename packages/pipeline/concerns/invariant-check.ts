/**
 * invariant-check — Run predicate functions against proposed record state.
 *
 * STABLE — ADR 05 invariant. Reads InvariantConfig predicates from participation config.
 * severity: 'error' throws. severity: 'warning' captured in outboundErrors.
 */

import type { ExecutionHandler } from '@janus/core';

interface InvariantInput {
  readonly name: string;
  readonly predicate: (record: Record<string, unknown>) => boolean;
  readonly severity: 'error' | 'warning';
  readonly message?: string;
}

export const invariantCheck: ExecutionHandler = async (ctx) => {
  const config = ctx.config as { predicates?: readonly InvariantInput[] };
  if (!config?.predicates || config.predicates.length === 0) return;

  // Build proposed state: for create use parsed, for update merge before + parsed
  const proposed: Record<string, unknown> =
    ctx.operation === 'create'
      ? { ...(ctx.parsed ?? {}) }
      : { ...(ctx.before as Record<string, unknown> ?? {}), ...(ctx.parsed ?? {}) };

  for (const invariant of config.predicates) {
    const passes = invariant.predicate(proposed);
    if (!passes) {
      const message = invariant.message ?? `Invariant '${invariant.name}' violated`;
      if (invariant.severity === 'error') {
        throw Object.assign(new Error(message), {
          kind: 'invariant-violation',
          retryable: false,
          details: { invariant: invariant.name },
        });
      }
      // Warning — capture but don't throw
      if (!ctx.outboundErrors) ctx.outboundErrors = [];
      ctx.outboundErrors.push({ stage: `invariant:${invariant.name}`, error: message });
    }
  }
};
