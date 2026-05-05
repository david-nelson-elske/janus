/**
 * Dispatch runtime — executes frozen pipelines.
 *
 * STABLE — the dispatch flow (lookup pipeline → build context → run preTx/tx/postTx)
 * is an ADR-06 invariant. The runFlatPipeline algorithm is ported from packages/next.
 *
 * UPDATE @ M4 (ADR 01b): Add broker notification after emit concern.
 * UPDATE @ M6 (ADR 08): Initiator comes from the HTTP surface, not hardcoded.
 */

import type {
  AgentRequestContext,
  AssetBackend,
  ConcernContext,
  CompileResult,
  DispatchError,
  DispatchResponse,
  EntityStore,
  FrozenPipeline,
  HttpRequestContext,
  Identity,
  Operation,
  PipelineStage,
} from '@janus/core';
import { SYSTEM, copyOwnCtxFields, extractResultData } from '@janus/core';
import { buildContext } from './context';

// ── Configuration ───────────────────────────────────────────────

export interface DispatchRuntimeConfig {
  readonly registry: CompileResult;
  readonly store: EntityStore;
  readonly broker?: ConcernContext['broker'];
  readonly assetBackend?: AssetBackend;
  readonly maxDepth?: number;
  readonly defaultIdentity?: Identity;
}

export interface DispatchContext {
  readonly httpRequest?: HttpRequestContext;
  readonly agentRequest?: AgentRequestContext;
}

export interface DispatchRuntime {
  dispatch(
    initiator: string,
    entity: string,
    operation: string,
    input: unknown,
    identity?: Identity,
    context?: DispatchContext,
  ): Promise<DispatchResponse>;
}

// ── Create dispatch runtime ─────────────────────────────────────

export function createDispatchRuntime(config: DispatchRuntimeConfig): DispatchRuntime {
  const maxDepth = config.maxDepth ?? 5;
  const defaultIdentity = config.defaultIdentity ?? SYSTEM;

  async function dispatch(
    initiator: string,
    entity: string,
    operation: string,
    input: unknown,
    identity?: Identity,
    context?: DispatchContext,
    depth = 0,
  ): Promise<DispatchResponse> {
    const startedAt = performance.now();
    const correlationId = crypto.randomUUID();
    const traceId = correlationId;
    const resolvedIdentity = identity ?? defaultIdentity;

    // Validate entity exists
    const entityRecord = config.registry.entity(entity);
    if (!entityRecord) {
      return errorResponse(
        { kind: 'unknown-entity', message: `Unknown entity: '${entity}'`, retryable: false },
        correlationId, entity, operation, startedAt, depth,
      );
    }

    // Resolve operation — transitions rewrite to 'update', actions pass through
    let resolvedOperation: Operation = operation as Operation;
    const isTransition = entityRecord.transitionTargets.some((t) => t.name === operation);
    if (isTransition) {
      const target = entityRecord.transitionTargets.find((t) => t.name === operation)!;
      input = { ...(input as Record<string, unknown> ?? {}), [target.field]: target.to };
      resolvedOperation = 'update';
    } else if (!entityRecord.operations.includes(resolvedOperation)) {
      // Not a standard op — might be a custom action (ADR 07c).
      // Pipeline lookup below will catch it if no action pipeline was compiled.
      resolvedOperation = operation as Operation;
    }

    // Depth check
    if (depth >= maxDepth) {
      return errorResponse(
        { kind: 'max-depth', message: `Max dispatch depth (${maxDepth}) exceeded`, retryable: false },
        correlationId, entity, operation, startedAt, depth,
      );
    }

    // Single pipeline lookup — covers standard ops, transitions, and custom actions
    const pipeline = config.registry.pipeline(initiator, entity, resolvedOperation);
    if (!pipeline) {
      return errorResponse(
        { kind: 'unsupported-operation', message: `Entity '${entity}' does not support operation '${operation}' (initiator: ${initiator})`, retryable: false },
        correlationId, entity, operation, startedAt, depth,
      );
    }

    // Build context
    const ctx = buildContext({
      correlationId,
      traceId,
      identity: resolvedIdentity,
      entity,
      operation: resolvedOperation,
      input,
      depth,
      store: config.store,
      registry: config.registry,
      broker: config.broker,
      assetBackend: config.assetBackend,
      httpRequest: context?.httpRequest,
      agentRequest: context?.agentRequest,
      _dispatch: (e, op, inp, id) => dispatch('system', e, op, inp, id, undefined, depth + 1),
    });

    // Run pipeline
    try {
      await runFlatPipeline(pipeline, ctx, config.store);
    } catch (err) {
      const error = toDispatchError(err);
      return errorResponse(error, correlationId, entity, operation, startedAt, depth);
    }

    // Build success response
    const data = extractResultData(ctx.result);

    return {
      ok: true,
      data,
      meta: {
        correlationId,
        entity,
        operation,
        durationMs: performance.now() - startedAt,
        depth,
      },
      ...(ctx.extensions ? { extensions: ctx.extensions } : {}),
    };
  }

  return {
    dispatch: (initiator, entity, operation, input, identity, context) =>
      dispatch(initiator, entity, operation, input, identity, context, 0),
  };
}

// ── Pipeline execution ──────────────────────────────────────────

/**
 * STABLE — the preTx → tx (in transaction) → postTx execution pattern
 * is an ADR-03/06 invariant. Same algorithm as packages/next's runFlatPipeline.
 */
async function runFlatPipeline(
  pipeline: FrozenPipeline,
  ctx: ConcernContext,
  store: EntityStore,
): Promise<void> {
  // Pre-transaction stages — errors abort the pipeline
  for (const stage of pipeline.preTx) {
    await stage(ctx);
  }

  // Transaction stages
  if (pipeline.needsTx && pipeline.tx.length > 0) {
    await store.withTransaction(async (txStore) => {
      // Replace store on context for transaction stages
      const txCtx = Object.create(ctx);
      txCtx.store = txStore;

      for (const stage of pipeline.tx) {
        await stage(txCtx);
      }

      copyOwnCtxFields(txCtx, ctx);
    });
  } else {
    // No transaction needed — run tx stages inline
    for (const stage of pipeline.tx) {
      await stage(ctx);
    }
  }

  // Post-transaction stages — errors are captured, not thrown
  for (const stage of pipeline.postTx) {
    try {
      await stage(ctx);
    } catch (err) {
      if (!ctx.outboundErrors) ctx.outboundErrors = [];
      ctx.outboundErrors.push({ stage: 'postTx', error: err });
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function errorResponse(
  error: DispatchError,
  correlationId: string,
  entity: string,
  operation: string,
  startedAt: number,
  depth: number,
): DispatchResponse {
  return {
    ok: false,
    error,
    meta: {
      correlationId,
      entity,
      operation,
      durationMs: performance.now() - startedAt,
      depth,
    },
  };
}

function toDispatchError(err: unknown): DispatchError {
  if (err instanceof Error) {
    const e = err as Error & { kind?: string; retryable?: boolean; details?: Record<string, unknown> };
    // Forward any additional thrown props (e.g. scope-enforce's
    // entity/operation/role/campaignId on OBSERVER_DENIED) at top level so
    // downstream code can pattern-match on `err.entity` etc. directly.
    const aux: Record<string, unknown> = {};
    for (const key of Object.keys(e)) {
      if (key === 'kind' || key === 'message' || key === 'retryable' || key === 'name' || key === 'stack' || key === 'cause' || key === 'details') {
        continue;
      }
      aux[key] = (e as unknown as Record<string, unknown>)[key];
    }
    return {
      kind: e.kind ?? 'internal',
      message: e.message,
      retryable: e.retryable ?? false,
      ...aux,
      ...(e.details ? { details: e.details } : {}),
    };
  }
  return { kind: 'internal', message: String(err), retryable: false };
}
