/**
 * SSE handler — Opens Server-Sent Event streams via Hono.
 *
 * GET /events?subscribe=entity1,entity2,entity3:id
 *
 * Creates a ReadableStream, registers the connection with the ConnectionManager,
 * and holds the response open. The stream-pusher handler pushes events through
 * the connection manager.
 */

import type { Context } from 'hono';
import type { ConnectionManager } from '@janus/pipeline';

export interface SseHandlerConfig {
  readonly connectionManager: ConnectionManager;
  readonly heartbeatMs?: number;
  /** Resolve userId from request. Falls back to 'anonymous' if not provided or returns null. */
  readonly resolveUserId?: (req: Request) => Promise<string | null>;
}

/**
 * Parse the subscribe query param into entity subscriptions.
 * Format: "task,adr,task:123" → Set<"task", "adr", "task:123">
 */
function parseSubscribeParam(param: string): Set<string> {
  const subs = new Set<string>();
  for (const part of param.split(',')) {
    const trimmed = part.trim();
    if (trimmed) subs.add(trimmed);
  }
  return subs;
}

/**
 * Create a Hono route handler for SSE connections.
 */
export function createSseHandler(config: SseHandlerConfig) {
  const heartbeatMs = config.heartbeatMs ?? 30_000;
  const encoder = new TextEncoder();

  return async (c: Context) => {
    const subscribeParam = c.req.query('subscribe') ?? '';
    const subscriptions = parseSubscribeParam(subscribeParam);

    if (subscriptions.size === 0) {
      return c.json({ ok: false, error: { kind: 'validation-error', message: 'subscribe param required' } }, 400);
    }

    const connectionId = crypto.randomUUID();
    const now = Date.now();

    // Resolve identity from request
    let userId = 'anonymous';
    if (config.resolveUserId) {
      try {
        userId = (await config.resolveUserId(c.req.raw)) ?? 'anonymous';
      } catch {
        // Fall back to anonymous on resolution failure
      }
    }

    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Create a string-level proxy for the connection manager
        const stringProxy = {
          enqueue(chunk: string) {
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              // Stream closed
            }
          },
          close() {
            try {
              controller.close();
            } catch {
              // Already closed
            }
          },
        };

        // Register connection
        config.connectionManager.add({
          id: connectionId,
          userId,
          controller: stringProxy,
          subscriptions,
          connectedAt: now,
          lastHeartbeat: now,
        });

        // Send initial connected event
        stringProxy.enqueue(`data: ${JSON.stringify({ type: 'connected', connectionId, subscriptions: [...subscriptions] })}\n\n`);

        // Start heartbeat
        heartbeatInterval = setInterval(() => {
          const conn = config.connectionManager.get(connectionId);
          if (!conn) {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            return;
          }
          try {
            stringProxy.enqueue(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
            conn.lastHeartbeat = Date.now();
          } catch {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            config.connectionManager.remove(connectionId);
          }
        }, heartbeatMs);
      },

      cancel() {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        config.connectionManager.remove(connectionId);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Connection-Id': connectionId,
      },
    });
  };
}
