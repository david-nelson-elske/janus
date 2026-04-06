/**
 * Tests for SSE handler — createSseHandler() creates a Hono route handler
 * that opens Server-Sent Event streams, registers connections, and sends
 * heartbeats.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createSseHandler } from '..';
import { createConnectionManager } from '@janus/pipeline';
import type { ConnectionManager } from '@janus/pipeline';

let cm: ConnectionManager;
let app: Hono;

beforeEach(() => {
  cm = createConnectionManager();
});

afterEach(() => {
  // Clean up any lingering connections
  for (const conn of cm.all()) {
    cm.remove(conn.id);
  }
});

function mountHandler(heartbeatMs?: number) {
  const handler = createSseHandler({ connectionManager: cm, heartbeatMs });
  app = new Hono();
  app.get('/events', handler);
}

function get(path: string) {
  return app.fetch(new Request(`http://localhost${path}`));
}

// ── Validation ──────────────────────────────────────────────────

describe('SSE handler validation', () => {
  test('missing subscribe param returns 400', async () => {
    mountHandler();
    const res = await get('/events');
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.kind).toBe('validation-error');
    expect(json.error.message).toContain('subscribe param required');
  });

  test('empty subscribe param returns 400', async () => {
    mountHandler();
    const res = await get('/events?subscribe=');
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  test('whitespace-only subscribe param returns 400', async () => {
    mountHandler();
    const res = await get('/events?subscribe=%20,%20');
    expect(res.status).toBe(400);
  });
});

// ── Successful SSE connection ───────────────────────────────────

describe('SSE handler connection', () => {
  test('valid subscribe returns 200 with SSE headers', async () => {
    mountHandler();
    const res = await get('/events?subscribe=task');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');
    expect(res.headers.get('X-Connection-Id')).toBeDefined();
  });

  test('connection is registered in the connection manager', async () => {
    mountHandler();
    expect(cm.size).toBe(0);

    const res = await get('/events?subscribe=task');
    const connectionId = res.headers.get('X-Connection-Id')!;

    // The stream start() runs synchronously with ReadableStream creation
    expect(cm.size).toBe(1);
    const conn = cm.get(connectionId);
    expect(conn).toBeDefined();
    expect(conn!.userId).toBe('anonymous');
    expect(conn!.subscriptions.has('task')).toBe(true);
  });

  test('multiple subscriptions are tracked', async () => {
    mountHandler();
    const res = await get('/events?subscribe=task,adr,note');
    const connectionId = res.headers.get('X-Connection-Id')!;
    const conn = cm.get(connectionId)!;

    expect(conn.subscriptions.size).toBe(3);
    expect(conn.subscriptions.has('task')).toBe(true);
    expect(conn.subscriptions.has('adr')).toBe(true);
    expect(conn.subscriptions.has('note')).toBe(true);
  });

  test('instance-level subscriptions are tracked', async () => {
    mountHandler();
    const res = await get('/events?subscribe=task:abc123,adr');
    const connectionId = res.headers.get('X-Connection-Id')!;
    const conn = cm.get(connectionId)!;

    expect(conn.subscriptions.has('task:abc123')).toBe(true);
    expect(conn.subscriptions.has('adr')).toBe(true);
  });

  test('trims whitespace from subscription entries', async () => {
    mountHandler();
    const res = await get('/events?subscribe=%20task%20,%20adr%20');
    const connectionId = res.headers.get('X-Connection-Id')!;
    const conn = cm.get(connectionId)!;

    expect(conn.subscriptions.has('task')).toBe(true);
    expect(conn.subscriptions.has('adr')).toBe(true);
  });
});

// ── Stream content ──────────────────────────────────────────────

describe('SSE handler stream', () => {
  test('sends connected event as first message', async () => {
    mountHandler();
    const res = await get('/events?subscribe=task');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toContain('data: ');
    expect(text).toContain('"type":"connected"');
    expect(text).toContain('"task"');
    // connectionId should be in the event
    const connectionId = res.headers.get('X-Connection-Id')!;
    expect(text).toContain(connectionId);

    reader.cancel();
  });

  test('connected event includes all subscriptions', async () => {
    mountHandler();
    const res = await get('/events?subscribe=task,adr');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    expect(text).toContain('"task"');
    expect(text).toContain('"adr"');

    reader.cancel();
  });
});

// ── Heartbeat ───────────────────────────────────────────────────

describe('SSE handler heartbeat', () => {
  test('sends heartbeat after interval', async () => {
    // Use a very short heartbeat to test without long delays
    mountHandler(50);
    const res = await get('/events?subscribe=task');
    const reader = res.body!.getReader();

    // Read the connected event
    await reader.read();

    // Wait for heartbeat
    await new Promise((r) => setTimeout(r, 100));

    // Read the heartbeat event
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"type":"heartbeat"');
    expect(text).toContain('"timestamp"');

    reader.cancel();
  });

  test('heartbeat updates lastHeartbeat on connection', async () => {
    mountHandler(50);
    const res = await get('/events?subscribe=task');
    const connectionId = res.headers.get('X-Connection-Id')!;
    const reader = res.body!.getReader();

    // Read connected event
    await reader.read();

    const initialHeartbeat = cm.get(connectionId)!.lastHeartbeat;

    // Wait for heartbeat
    await new Promise((r) => setTimeout(r, 100));
    await reader.read();

    const updatedHeartbeat = cm.get(connectionId)!.lastHeartbeat;
    expect(updatedHeartbeat).toBeGreaterThanOrEqual(initialHeartbeat);

    reader.cancel();
  });
});

// ── Stream cancellation ─────────────────────────────────────────

describe('SSE handler cancellation', () => {
  test('cancelling the stream removes the connection', async () => {
    mountHandler();
    const res = await get('/events?subscribe=task');
    const connectionId = res.headers.get('X-Connection-Id')!;

    expect(cm.get(connectionId)).toBeDefined();

    // Cancel the stream
    res.body!.cancel();
    await new Promise((r) => setTimeout(r, 10));

    expect(cm.get(connectionId)).toBeUndefined();
    expect(cm.size).toBe(0);
  });

  test('heartbeat stops after connection is externally removed', async () => {
    mountHandler(50);
    const res = await get('/events?subscribe=task');
    const connectionId = res.headers.get('X-Connection-Id')!;
    const reader = res.body!.getReader();

    // Read connected event
    await reader.read();

    // Externally remove the connection
    cm.remove(connectionId);
    expect(cm.size).toBe(0);

    // Wait for heartbeat interval to fire — it should see conn is gone and stop
    await new Promise((r) => setTimeout(r, 100));

    // Connection should still be absent (heartbeat didn't re-add it)
    expect(cm.size).toBe(0);

    reader.cancel();
  });
});
