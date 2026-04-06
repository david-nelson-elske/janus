/**
 * http-respond — Shape dispatch result into HTTP response.
 *
 * Order=80, non-transactional (postTx). Writes to ctx.extensions.httpResponse
 * so the Hono handler can read the shaped response from DispatchResponse.extensions.
 */

import type { ExecutionHandler, Operation } from '@janus/core';
import { extractResultData } from '@janus/core';

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function operationToStatus(operation: Operation, hasResult: boolean): number {
  switch (operation) {
    case 'create':
      return 201;
    case 'delete':
      return 204;
    default:
      return 200;
  }
}

function errorToStatus(kind: string): number {
  switch (kind) {
    // 400 — malformed request
    case 'invalid-query':
    case 'max-depth':
      return 400;
    // 403 — forbidden
    case 'auth-error':
    case 'read-only':
      return 403;
    // 404 — not found
    case 'not-found':
    case 'unknown-entity':
    case 'unsupported-operation':
      return 404;
    // 409 — conflict
    case 'conflict':
    case 'version-conflict':
    case 'constraint-violation':
    case 'restrict-violation':
      return 409;
    // 422 — unprocessable entity
    case 'parse-error':
    case 'validation-error':
    case 'invariant-violation':
    case 'lifecycle-violation':
      return 422;
    // 429 — rate limited
    case 'rate-limit-exceeded':
      return 429;
    // 502 — external dependency failure
    case 'config-error':
    case 'connector-push-error':
      return 502;
    // 500 — internal
    default:
      return 500;
  }
}

export const httpRespond: ExecutionHandler = async (ctx) => {
  if (!ctx.extensions) ctx.extensions = {};

  if (ctx.error) {
    const httpResponse: HttpResponse = {
      status: errorToStatus(ctx.error.kind),
      body: { ok: false, error: ctx.error },
    };
    ctx.extensions.httpResponse = httpResponse;
    return;
  }

  const data = extractResultData(ctx.result);

  const status = operationToStatus(ctx.operation, !!data);
  const body = status === 204 ? null : { ok: true, data };

  const httpResponse: HttpResponse = { status, body };
  ctx.extensions.httpResponse = httpResponse;
};
