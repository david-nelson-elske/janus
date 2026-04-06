# 124-06: Dispatch Runtime

**Status:** Draft
**Date:** 2026-04-02
**Depends on:** [03](03-compile-and-dispatch-index.md) (Compile), [04](04-store-adapters-and-crud.md) (Store), [05](05-pipeline-concern-adapters.md) (Concern Adapters)

## Scope

This sub-ADR specifies:
- `createDispatchRuntime()` — the pipeline executor factory
- `DispatchRuntime` interface — the dispatch entry point
- `DispatchResponse` — the response envelope
- Pipeline execution: preTx → tx (with transaction) → postTx
- Re-entrant dispatch (depth tracking, max depth)
- Error handling: stage errors, outbound error capture
- The `system` initiator as default for internal dispatch
- `runFlatPipeline()` — the stage runner carried forward from packages/next

This sub-ADR does NOT cover:
- HTTP surface parsing/routing ([08](08-http-surface-and-bootstrap.md))
- Agent surface ([09](09-agent-surface-and-session.md))
- Subscription/event processing ([07](07-subscriptions-broker-scheduler.md))
- Concern adapter implementations ([05](05-pipeline-concern-adapters.md))
- Store adapter internals ([04](04-store-adapters-and-crud.md))

## createDispatchRuntime()

Factory that produces a `DispatchRuntime` from a compile result and infrastructure:

```ts
function createDispatchRuntime(config: {
  registry: CompileResult;
  store: EntityStore;
  broker: Broker;
  maxDepth?: number;           // default: 5
}): DispatchRuntime
```

## DispatchRuntime

```ts
interface DispatchRuntime {
  dispatch(
    initiator: string,
    entity: string,
    operation: string,
    input: unknown,
    identity: Identity,
    parentCtx?: ParentContext,
  ): Promise<DispatchResponse>;
}

interface ParentContext {
  readonly correlationId: string;
  readonly traceId: string;
  readonly depth: number;
}
```

The `initiator` parameter is new — packages/next had no initiator concept at dispatch time. Every dispatch explicitly names the initiator. For internal dispatch (subscriptions, handler-to-handler), the initiator is `'system'`.

## DispatchResponse

```ts
interface DispatchResponse {
  readonly ok: boolean;
  readonly data?: EntityRecord | ReadPage | unknown;
  readonly meta: {
    readonly correlationId: string;
    readonly traceId: string;
    readonly initiator: string;
    readonly entity: string;
    readonly operation: string;
    readonly durationMs: number;
    readonly depth: number;
  };
  readonly error?: DispatchError;
  readonly warnings?: readonly DispatchWarning[];
}

interface DispatchWarning {
  readonly stage: string;
  readonly message: string;
}

interface DispatchError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}
```

## Dispatch flow

```
dispatch(initiator, entity, operation, input, identity, parentCtx?):

  1. Generate correlationId (or inherit from parentCtx)
     Generate traceId (or inherit from parentCtx)
     Compute depth (parentCtx?.depth + 1, or 0)

  2. Depth check: if depth > maxDepth → return error response (MaxDepthExceeded)

  3. Validate operation: check that operation is in graphNode.operations
     If entity unknown → return error response (UnknownEntity)
     If operation unknown → return error response (UnknownOperation)

  4. Pipeline lookup: registry.pipeline(initiator, entity, operation)
     If no pipeline → return error response (NoPipelineFound)

  5. Build ConcernContext:
     - Immutable fields from dispatch arguments
     - Infrastructure: store, broker, registry
     - _dispatch: bound re-entrant dispatch (system initiator, inherited correlation)

  6. Execute pipeline: runFlatPipeline(pipeline, ctx)

  7. Build DispatchResponse from ctx:
     - ok: !ctx.error
     - data: ctx.result?.record || ctx.result?.page || ctx.result?.data
     - meta: { correlationId, traceId, initiator, entity, operation, durationMs, depth }
     - error: ctx.error
     - warnings: ctx.outboundErrors?.map(...)
```

## runFlatPipeline()

The stage runner, carried forward from packages/next with minimal changes:

```ts
async function runFlatPipeline(pipeline: FrozenPipeline, ctx: ConcernContext): Promise<void> {
  // 1. Run preTx stages sequentially
  for (const stage of pipeline.preTx) {
    await stage(ctx);
    if (ctx.error) return; // Short-circuit on error
  }

  // 2. Run tx stages (optionally within transaction)
  if (pipeline.needsTx && pipeline.tx.length > 0) {
    await ctx.store.withTransaction(async (txStore) => {
      const txCtx = { ...ctx, store: txStore }; // swap store for tx-scoped store
      for (const stage of pipeline.tx) {
        await stage(txCtx);
        if (txCtx.error) throw txCtx.error; // rollback on error
      }
      // Copy mutable fields back to outer ctx
      Object.assign(ctx, txCtx);
    });
  } else {
    // No transaction needed (reads, or needsTx=false)
    for (const stage of pipeline.tx) {
      await stage(ctx);
      if (ctx.error) return;
    }
  }

  // 3. Run postTx stages sequentially (error-captured)
  for (const stage of pipeline.postTx) {
    try {
      await stage(ctx);
    } catch (err) {
      ctx.outboundErrors ??= [];
      ctx.outboundErrors.push({ stage: stage.name || 'unknown', error: err });
    }
  }
}
```

**Key behaviors:**
- **preTx short-circuits on error.** If policy denies, parse fails, or validate rejects, the pipeline stops before the transaction.
- **tx rolls back on error.** Any error inside the transaction causes rollback. The error is set on `ctx.error`.
- **postTx captures errors.** Observe/respond failures are captured as warnings, not thrown. The dispatch response still succeeds if the core operation succeeded.

## Re-entrant dispatch

When a concern adapter or action handler needs to dispatch another operation (e.g., a subscription handler dispatching `feed:notify`), it uses the `_dispatch` function on the context:

```ts
// Inside an action handler
const feedResult = await ctx._dispatch('feed', 'create', { message: '...' }, ctx.identity);
```

This always uses `system` as the initiator (internal dispatch). The depth increments. If depth exceeds `maxDepth`, the dispatch returns an error response without executing.

The `_dispatch` function is bound during context construction:

```ts
ctx._dispatch = (entity, operation, input, identity) =>
  runtime.dispatch('system', entity, operation, input, identity, {
    correlationId: ctx.correlationId,
    traceId: ctx.traceId,
    depth: ctx.depth,
  });
```

## Error types

```ts
// Carried forward from packages/next, with additions

const MaxDepthExceeded: DispatchError;
const UnknownEntity: (entity: string) => DispatchError;
const UnknownOperation: (entity: string, operation: string) => DispatchError;
const NoPipelineFound: (initiator: string, entity: string, operation: string) => DispatchError;
const ForbiddenError: (reason: string) => DispatchError;
const RateLimitExceededError: (entity: string, identity: string) => DispatchError;
const ValidationError: (field: string, message: string) => DispatchError;
const InvariantViolationError: (name: string, message: string) => DispatchError;
const NotFoundError: (entity: string, id: string) => DispatchError;
```

## ConcernContext construction

Each pipeline stage receives the same `ConcernContext` instance, but with a different `config` field — the participation record's config for that specific execution. This is achieved during compilation: each `PipelineStage` closure captures the participation config and injects it into the context before calling the handler.

```ts
// During compile, for each participation record:
const stage: PipelineStage = async (ctx) => {
  const stageCtx = Object.create(ctx);
  stageCtx.config = participationRecord.config;
  await executionHandler(stageCtx);
};
```

This means each concern adapter sees `ctx.config` as its own per-entity config, not a shared config object.

## Testing gate

When 124-06 is implemented, the following should be testable:

- `dispatch('system', 'note', 'create', { title: 'Test' }, identity)` runs the full pipeline and returns `{ ok: true, data: record }`
- `dispatch('api-surface', 'note', 'create', ...)` runs transport + domain pipeline
- Read dispatch returns `{ ok: true, data: page }` with `needsTx: false`
- Unknown entity returns `{ ok: false, error: UnknownEntity }`
- Unknown operation returns `{ ok: false, error: UnknownOperation }`
- Policy denial returns `{ ok: false, error: Forbidden }`
- Re-entrant dispatch increments depth, respects maxDepth
- maxDepth exceeded returns `{ ok: false, error: MaxDepthExceeded }`
- Error in preTx prevents tx execution
- Error in tx causes rollback (create + rollback → no record in store)
- Error in postTx is captured as warning, dispatch still succeeds
- Each pipeline stage receives its own config from the participation record
- DispatchResponse includes correct meta (correlationId, traceId, initiator, entity, operation, durationMs, depth)
- `ctx._dispatch` is available for re-entrant dispatch
