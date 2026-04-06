/**
 * Connection manager — in-memory tracking of active SSE connections.
 *
 * Connections are volatile (not persisted). Each connection holds a writable
 * stream controller for pushing SSE events, plus metadata for subscription matching.
 *
 * M8-render: SSE-only. WebSocket support deferred.
 */

/** Minimal controller interface for pushing SSE messages. */
export interface SseController {
  enqueue(chunk: string): void;
  close(): void;
}

export interface SseConnection {
  readonly id: string;
  readonly userId: string;
  readonly controller: SseController;
  readonly subscriptions: Set<string>;     // entity names or "entity:id" for instance-level
  readonly connectedAt: number;
  lastHeartbeat: number;
}

export interface ServerMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ConnectionManager {
  /** Add a new SSE connection. */
  add(conn: SseConnection): void;
  /** Remove a connection by id. */
  remove(id: string): void;
  /** Get a connection by id. */
  get(id: string): SseConnection | undefined;
  /** Find all connections subscribed to an entity (type-level or instance-level). */
  findSubscribers(entity: string, entityId?: string): readonly SseConnection[];
  /** Push a message to a specific connection. */
  push(connectionId: string, message: ServerMessage): boolean;
  /** Push a message to all matching subscribers. */
  pushToSubscribers(entity: string, entityId: string | undefined, message: ServerMessage, skipConnectionId?: string): void;
  /** All active connections (for heartbeat, cleanup, etc.). */
  all(): readonly SseConnection[];
  /** Number of active connections. */
  size: number;
}

/**
 * Format a ServerMessage as an SSE data line.
 */
function formatSseMessage(message: ServerMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

export function createConnectionManager(): ConnectionManager {
  const connections = new Map<string, SseConnection>();

  return {
    add(conn) {
      connections.set(conn.id, conn);
    },

    remove(id) {
      const conn = connections.get(id);
      if (conn) {
        try {
          conn.controller.close();
        } catch {
          // Already closed
        }
        connections.delete(id);
      }
    },

    get(id) {
      return connections.get(id);
    },

    findSubscribers(entity, entityId) {
      const result: SseConnection[] = [];
      for (const conn of connections.values()) {
        // Match type-level subscription (entity name)
        if (conn.subscriptions.has(entity)) {
          result.push(conn);
          continue;
        }
        // Match instance-level subscription (entity:id)
        if (entityId && conn.subscriptions.has(`${entity}:${entityId}`)) {
          result.push(conn);
        }
      }
      return result;
    },

    push(connectionId, message) {
      const conn = connections.get(connectionId);
      if (!conn) return false;
      try {
        conn.controller.enqueue(formatSseMessage(message));
        return true;
      } catch {
        // Connection closed, remove it
        connections.delete(connectionId);
        return false;
      }
    },

    pushToSubscribers(entity, entityId, message, skipConnectionId) {
      const subscribers = this.findSubscribers(entity, entityId);
      for (const conn of subscribers) {
        if (skipConnectionId && conn.id === skipConnectionId) continue;
        try {
          conn.controller.enqueue(formatSseMessage(message));
        } catch {
          connections.delete(conn.id);
        }
      }
    },

    all() {
      return [...connections.values()];
    },

    get size() {
      return connections.size;
    },
  };
}
