/**
 * createHttpApp() — Wire route table into a Hono instance.
 *
 * Each route delegates to the dispatch runtime. HTTP metadata (params, query,
 * body, headers) is passed via the dispatch context — not smuggled through input.
 * The pipeline runs http-receive (merges into ctx.parsed), http-identity
 * (resolves caller), and http-respond (shapes ctx.extensions.httpResponse).
 *
 * UPDATE @ M8-render: Add SSE endpoint and SSR page routes.
 */

import { Hono } from 'hono';
import type { AssetBackend, CompileResult, HttpRequestContext, InitiatorConfig } from '@janus/core';
import { SYSTEM } from '@janus/core';
import { isSemanticField } from '@janus/vocabulary';
import type { DispatchRuntime, ConnectionManager } from '@janus/pipeline';
import type { HttpResponse } from '@janus/pipeline';
import { deriveRouteTable } from './route-table';
import { createSseHandler } from './sse-handler';
import { createPageHandler } from './page-handler';

export interface CreateHttpAppConfig {
  readonly registry: CompileResult;
  readonly runtime: DispatchRuntime;
  readonly surfaces: readonly { readonly initiator: InitiatorConfig; readonly basePath: string }[];
  readonly connectionManager?: ConnectionManager;
  readonly assetBackend?: AssetBackend;
  readonly enablePages?: boolean;
}

/**
 * Create a Hono app with routes derived from the dispatch index.
 */
export function createHttpApp(config: CreateHttpAppConfig): Hono {
  const app = new Hono();

  for (const surface of config.surfaces) {
    const routes = deriveRouteTable(config.registry, surface.initiator.name, surface.basePath);

    // SSE endpoint
    if (config.connectionManager) {
      const sseHandler = createSseHandler({
        connectionManager: config.connectionManager,
      });
      app.get(`${surface.basePath}/events`, sseHandler);
    }

    // Asset routes (ADR 08b) — multipart upload + file serving
    if (config.assetBackend) {
      const backend = config.assetBackend;
      const assetsBase = `${surface.basePath}/assets`.replace(/\/\//g, '/');

      // POST /assets — multipart upload
      app.post(assetsBase, async (c) => {
        const contentType = c.req.header('content-type') ?? '';
        if (!contentType.includes('multipart/form-data')) {
          return c.json({ ok: false, error: { kind: 'parse-error', message: 'Expected multipart/form-data', retryable: false } }, 422);
        }

        const formData = await c.req.formData();
        const file = formData.get('file');
        if (!file || !(file instanceof File)) {
          return c.json({ ok: false, error: { kind: 'parse-error', message: 'Missing file field in multipart form', retryable: false } }, 422);
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const filename = file.name || 'upload';
        const fileContentType = (file.type || 'application/octet-stream').split(';')[0].trim();
        const writeResult = await backend.write(bytes, { filename, contentType: fileContentType });

        // Dispatch as normal asset create
        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        const response = await config.runtime.dispatch(
          surface.initiator.name,
          'asset',
          'create',
          {
            filename,
            content_type: fileContentType,
            size: writeResult.size,
            backend: 'local',
            path: writeResult.path,
            checksum: writeResult.checksum,
            alt: formData.get('alt') as string ?? undefined,
          },
          undefined,
          { httpRequest: { headers } },
        );

        const httpResponse = response.extensions?.httpResponse as HttpResponse | undefined;
        if (httpResponse) {
          return c.json(httpResponse.body, httpResponse.status as any);
        }
        if (response.ok) {
          return c.json({ ok: true, data: response.data }, 201);
        }
        return c.json({ ok: false, error: response.error }, 500);
      });

      // GET /assets/:id/:filename — serve file
      app.get(`${assetsBase}/:id/:filename`, async (c) => {
        const { id } = c.req.param();

        const response = await config.runtime.dispatch(
          surface.initiator.name,
          'asset',
          'read',
          { id },
          undefined,
          {},
        );

        if (!response.ok) {
          return c.json({ ok: false, error: response.error }, 404);
        }

        const record = response.data as Record<string, unknown>;
        const path = record.path as string;
        const fileContentType = record.content_type as string;

        try {
          const bytes = await backend.read(path);
          return new Response(bytes as unknown as BodyInit, {
            status: 200,
            headers: {
              'content-type': fileContentType,
              'content-length': String(bytes.length),
              'cache-control': 'public, max-age=31536000, immutable',
            },
          });
        } catch {
          return c.json({ ok: false, error: { kind: 'not-found', message: 'Asset file not found on disk', retryable: false } }, 404);
        }
      });

      // GET /assets/:id — read asset metadata (JSON)
      app.get(`${assetsBase}/:id`, async (c) => {
        const { id } = c.req.param();
        const response = await config.runtime.dispatch(
          surface.initiator.name,
          'asset',
          'read',
          { id },
          undefined,
          {},
        );

        if (!response.ok) {
          return c.json({ ok: false, error: response.error }, 404);
        }
        return c.json({ ok: true, data: response.data }, 200);
      });
    }

    // ── QrCode verification route ─────────────────────────────────
    // Scans all QrCode-bearing entities and resolves a code to its record.
    // GET /verify/:code → { entity, id, field, singleUse, record } | 404 | 410
    {
      const qrCodeFields: { entity: string; field: string; expiresWith?: string; singleUse?: boolean }[] = [];
      for (const [name, node] of config.registry.graphNodes) {
        for (const [fieldName, fieldDef] of Object.entries(node.schema)) {
          if (!isSemanticField(fieldDef) || fieldDef.kind !== 'qrcode') continue;
          const hints = fieldDef.hints as { expiresWith?: string; singleUse?: boolean };
          qrCodeFields.push({
            entity: name,
            field: fieldName,
            expiresWith: hints.expiresWith,
            singleUse: hints.singleUse,
          });
        }
      }

      if (qrCodeFields.length > 0) {
        app.get(`${surface.basePath}/verify/:code`, async (c) => {
          const code = c.req.param('code');
          if (!code) {
            return c.json({ ok: false, error: { kind: 'parse-error', message: 'Missing code parameter' } }, 400);
          }

          for (const qr of qrCodeFields) {
            // Read entities with matching code field
            const response = await config.runtime.dispatch(
              surface.initiator.name,
              qr.entity,
              'read',
              { [qr.field]: code },
              undefined,
              {},
            );

            if (!response.ok || !response.data) continue;

            // Handle both single-record and paginated responses
            const data = response.data as Record<string, unknown>;
            const records = data.records as Record<string, unknown>[] | undefined;
            const record = records && records.length > 0 ? records[0] : (data.id ? data : null);
            if (!record) continue;

            // Check expiry
            if (qr.expiresWith) {
              const expiresAt = record[qr.expiresWith];
              if (expiresAt) {
                const expiresTime = typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : Number(expiresAt);
                if (Date.now() > expiresTime) {
                  return c.json({
                    ok: false,
                    error: { kind: 'expired', message: 'Code has expired' },
                    entity: qr.entity,
                    id: record.id,
                  }, 410);
                }
              }
            }

            return c.json({
              ok: true,
              entity: qr.entity,
              id: record.id,
              field: qr.field,
              singleUse: qr.singleUse ?? false,
              record,
            }, 200);
          }

          return c.json({ ok: false, error: { kind: 'not-found', message: 'Code not found' } }, 404);
        });
      }
    }

    for (const route of routes) {
      app.on(route.method, route.path, async (c) => {
        // Extract HTTP parts
        const params = c.req.param();
        const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
        let body: Record<string, unknown> | undefined;
        if (route.method === 'POST' || route.method === 'PATCH') {
          try {
            body = await c.req.json();
          } catch {
            body = undefined;
          }
        }

        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });

        // HTTP metadata goes on the dispatch context, not on input
        const httpRequest: HttpRequestContext = { params, query, body, headers };

        const response = await config.runtime.dispatch(
          surface.initiator.name,
          route.entity,
          route.operation,
          {},
          undefined,
          { httpRequest },
        );

        // Read the shaped HTTP response from extensions
        const httpResponse = response.extensions?.httpResponse as HttpResponse | undefined;

        if (httpResponse) {
          if (httpResponse.status === 204) {
            return c.body(null, 204);
          }
          if (httpResponse.headers) {
            for (const [k, v] of Object.entries(httpResponse.headers)) {
              c.header(k, v);
            }
          }
          return c.json(httpResponse.body, httpResponse.status as any);
        }

        // Fallback: no http-respond ran (shouldn't happen with proper surface wiring)
        if (response.ok) {
          return c.json({ ok: true, data: response.data }, 200);
        }
        return c.json({ ok: false, error: response.error }, 500);
      });
    }
  }

  // Page routes (SSR) — catch-all, must come after API routes
  if (config.enablePages !== false && config.registry.bindings.length > 0) {
    const pageHandler = createPageHandler({
      registry: config.registry,
      runtime: config.runtime,
    });
    app.get('/*', pageHandler);
  }

  return app;
}
