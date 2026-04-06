/**
 * ConcernContext builder — constructs the pipeline context for dispatch.
 *
 * STABLE — the context shape is an ADR-05 invariant. The builder creates
 * the immutable infrastructure + empty mutable accumulators.
 *
 * For scoped handler contexts with config injection, use createHandlerContext()
 * from @janus/core — shared by pipeline stages and subscription processor.
 */

import type {
  AgentRequestContext,
  AssetBackend,
  ConcernContext,
  CompileResult,
  EntityStore,
  HttpRequestContext,
  Identity,
  InternalDispatch,
  Operation,
} from '@janus/core';

export function buildContext(args: {
  correlationId: string;
  traceId: string;
  identity: Identity;
  entity: string;
  operation: Operation;
  input: unknown;
  depth: number;
  store: EntityStore;
  registry: CompileResult;
  broker?: ConcernContext['broker'];
  assetBackend?: AssetBackend;
  httpRequest?: HttpRequestContext;
  agentRequest?: AgentRequestContext;
  _dispatch?: InternalDispatch;
}): ConcernContext {
  return {
    correlationId: args.correlationId,
    traceId: args.traceId,
    identity: args.identity,
    entity: args.entity,
    operation: args.operation,
    input: args.input,
    startedAt: performance.now(),
    depth: args.depth,
    config: {},
    store: args.store,
    registry: args.registry,
    broker: args.broker,
    assetBackend: args.assetBackend,
    httpRequest: args.httpRequest,
    agentRequest: args.agentRequest,
    _dispatch: args._dispatch,
  };
}
