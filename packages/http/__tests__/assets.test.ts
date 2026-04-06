/**
 * Integration tests for ADR 08b: Assets & Media over HTTP.
 *
 * Exercises: multipart upload, asset serving, asset metadata read.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { define, participate, clearRegistry } from '@janus/core';
import { Str, Asset, Persistent } from '@janus/vocabulary';
import { createLocalBackend } from '@janus/pipeline';
import { createApp, apiSurface } from '..';
import type { App } from '..';

let app: App;
let tmpDir: string;

beforeEach(async () => {
  clearRegistry();
  tmpDir = await mkdtemp(join(tmpdir(), 'janus-http-asset-'));

  const note = define('note', {
    schema: {
      title: Str({ required: true }),
      image: Asset(),
    },
    storage: Persistent(),
  });

  const noteP = participate(note, {});

  const surface = apiSurface({
    identity: {
      keys: { 'test-key': { id: 'user1', roles: ['admin'] } },
    },
  });

  app = await createApp({
    declarations: [note, noteP],
    surfaces: [surface],
    assetBackend: createLocalBackend({ directory: tmpDir, publicPath: '/api/assets' }),
  });
});

afterEach(async () => {
  await app.shutdown();
  clearRegistry();
  await rm(tmpDir, { recursive: true }).catch(() => {});
});

// ── Helpers ──────────────────────────────────────────────────────

function upload(file: File, alt?: string) {
  const form = new FormData();
  form.append('file', file);
  if (alt) form.append('alt', alt);
  return app.fetch(
    new Request('http://localhost/api/assets', {
      method: 'POST',
      body: form,
      headers: { 'x-api-key': 'test-key' },
    }),
  );
}

function get(path: string) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { 'x-api-key': 'test-key' },
    }),
  );
}

function post(path: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify(body),
    }),
  );
}

// ── Multipart upload ─────────────────────────────────────────────

describe('multipart upload', () => {
  test('uploads file and creates asset record', async () => {
    const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });
    const resp = await upload(file);
    expect(resp.status).toBe(201);

    const json = await resp.json() as { ok: boolean; data: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.data.filename).toBe('test.txt');
    expect(json.data.content_type).toBe('text/plain');
    expect(json.data.size).toBe(11);
    expect(json.data.checksum).toMatch(/^sha256:/);
    expect(json.data.backend).toBe('local');
  });

  test('upload with alt text', async () => {
    const file = new File([new Uint8Array(4)], 'photo.jpg', { type: 'image/jpeg' });
    const resp = await upload(file, 'A nice photo');
    const json = await resp.json() as { ok: boolean; data: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.data.alt).toBe('A nice photo');
  });

  test('rejects non-multipart POST', async () => {
    const resp = await app.fetch(
      new Request('http://localhost/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
        body: JSON.stringify({ filename: 'test.txt' }),
      }),
    );
    expect(resp.status).toBe(422);
    const json = await resp.json() as { ok: boolean; error: { kind: string } };
    expect(json.error.kind).toBe('parse-error');
  });

  test('rejects missing file field', async () => {
    const form = new FormData();
    form.append('alt', 'no file here');
    const resp = await app.fetch(
      new Request('http://localhost/api/assets', {
        method: 'POST',
        body: form,
        headers: { 'x-api-key': 'test-key' },
      }),
    );
    expect(resp.status).toBe(422);
  });
});

// ── Asset serving ────────────────────────────────────────────────

describe('asset serving', () => {
  test('serves uploaded file at /assets/:id/:filename', async () => {
    const content = 'file contents here';
    const file = new File([content], 'readme.txt', { type: 'text/plain' });
    const uploadResp = await upload(file);
    const { data } = await uploadResp.json() as { data: { id: string; filename: string } };

    const serveResp = await get(`/api/assets/${data.id}/${data.filename}`);
    expect(serveResp.status).toBe(200);
    expect(serveResp.headers.get('content-type')).toContain('text/plain');
    expect(serveResp.headers.get('cache-control')).toContain('immutable');

    const body = await serveResp.text();
    expect(body).toBe(content);
  });

  test('returns 404 for nonexistent asset', async () => {
    const resp = await get('/api/assets/nonexistent-id/foo.txt');
    expect(resp.status).toBe(404);
  });
});

// ── Asset metadata read ──────────────────────────────────────────

describe('asset metadata', () => {
  test('GET /assets/:id returns JSON metadata', async () => {
    const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
    const uploadResp = await upload(file);
    const { data } = await uploadResp.json() as { data: { id: string } };

    const metaResp = await get(`/api/assets/${data.id}`);
    expect(metaResp.status).toBe(200);

    const json = await metaResp.json() as { ok: boolean; data: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.data.filename).toBe('doc.pdf');
    expect(json.data.content_type).toBe('application/pdf');
  });
});

// ── Asset enrichment via HTTP ────────────────────────────────────

describe('asset enrichment on entity read', () => {
  test('reading entity with Asset() field returns enriched object', async () => {
    // Upload an asset
    const file = new File(['image data'], 'banner.png', { type: 'image/png' });
    const uploadResp = await upload(file, 'Site banner');
    const { data: assetData } = await uploadResp.json() as { data: { id: string } };

    // Create a note referencing the asset
    const createResp = await post('/api/notes', { title: 'My Post', image: assetData.id });
    expect(createResp.status).toBe(201);
    const { data: noteData } = await createResp.json() as { data: { id: string } };

    // Read the note — image should be enriched
    const readResp = await get(`/api/notes/${noteData.id}`);
    expect(readResp.status).toBe(200);
    const { data } = await readResp.json() as { data: Record<string, unknown> };

    const image = data.image as Record<string, unknown>;
    expect(image.id).toBe(assetData.id);
    expect(image.filename).toBe('banner.png');
    expect(image.content_type).toBe('image/png');
    expect(image.alt).toBe('Site banner');
    expect(typeof image.url).toBe('string');
  });
});
