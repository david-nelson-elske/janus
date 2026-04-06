/**
 * Integration tests for ADR 08b: Assets & Media.
 *
 * Exercises: asset framework entity, AssetBackend (local), CRUD operations.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  define,
  participate,
  compile,
  clearRegistry,
  SYSTEM,
} from '@janus/core';
import type { CompileResult, EntityStore } from '@janus/core';
import { createMemoryAdapter, createEntityStore } from '@janus/store';
import {
  registerHandlers,
  createDispatchRuntime,
  createBroker,
  frameworkEntities,
  frameworkParticipations,
  createLocalBackend,
} from '..';
import type { DispatchRuntime, AssetBackend } from '..';
import { Str, Asset, Persistent } from '@janus/vocabulary';

afterEach(() => {
  clearRegistry();
});

// ── Asset framework entity ──────────────────────────────────────

describe('asset framework entity', () => {
  test('asset entity is included in framework entities', () => {
    registerHandlers();
    const registry = compile([...frameworkEntities, ...frameworkParticipations]);
    expect(registry.entity('asset')).toBeDefined();
    expect(registry.entity('asset')!.origin).toBe('framework');
    expect(registry.entity('asset')!.owned).toBe(true);
  });

  test('asset CRUD works via dispatch', async () => {
    registerHandlers();

    const registry = compile([...frameworkEntities, ...frameworkParticipations]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });
    await store.initialize();

    const broker = createBroker();
    const runtime = createDispatchRuntime({ registry, store, broker });

    // Create an asset record
    const createResp = await runtime.dispatch('system', 'asset', 'create', {
      filename: 'photo.jpg',
      content_type: 'image/jpeg',
      size: 48291,
      backend: 'local',
      path: '2026-04/abc123-photo.jpg',
      checksum: 'sha256:deadbeef',
    }, SYSTEM);
    expect(createResp.ok).toBe(true);

    const assetId = (createResp.data as { id: string }).id;

    // Read it back
    const readResp = await runtime.dispatch('system', 'asset', 'read', { id: assetId }, SYSTEM);
    expect(readResp.ok).toBe(true);
    const record = readResp.data as Record<string, unknown>;
    expect(record.filename).toBe('photo.jpg');
    expect(record.content_type).toBe('image/jpeg');
    expect(record.size).toBe(48291);
    expect(record.backend).toBe('local');
    expect(record.checksum).toBe('sha256:deadbeef');
  });
});

// ── Local asset backend ─────────────────────────────────────────

describe('local asset backend', () => {
  let tmpDir: string;
  let backend: AssetBackend;

  test('write stores file and returns metadata', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'janus-asset-'));
    backend = createLocalBackend({ directory: tmpDir });

    const data = new TextEncoder().encode('hello world');
    const result = await backend.write(data, {
      filename: 'test.txt',
      contentType: 'text/plain',
    });

    expect(result.size).toBe(11);
    expect(result.checksum).toMatch(/^sha256:/);
    expect(result.path).toMatch(/^\d{4}-\d{2}\/.+-test\.txt$/);

    // Verify file exists on disk
    const onDisk = await readFile(join(tmpDir, result.path));
    expect(new TextDecoder().decode(onDisk)).toBe('hello world');

    await rm(tmpDir, { recursive: true });
  });

  test('url() produces correct public path', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'janus-asset-'));
    backend = createLocalBackend({ directory: tmpDir, publicPath: '/files' });

    expect(backend.url('2026-04/abc.jpg')).toBe('/files/2026-04/abc.jpg');

    await rm(tmpDir, { recursive: true });
  });

  test('read() returns file bytes', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'janus-asset-'));
    backend = createLocalBackend({ directory: tmpDir });

    const data = new TextEncoder().encode('read me');
    const result = await backend.write(data, {
      filename: 'readable.txt',
      contentType: 'text/plain',
    });

    const bytes = await backend.read(result.path);
    expect(new TextDecoder().decode(bytes)).toBe('read me');

    await rm(tmpDir, { recursive: true });
  });

  test('delete() removes file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'janus-asset-'));
    backend = createLocalBackend({ directory: tmpDir });

    const data = new TextEncoder().encode('delete me');
    const result = await backend.write(data, {
      filename: 'deletable.txt',
      contentType: 'text/plain',
    });

    await backend.delete(result.path);

    // Subsequent read should fail
    let err: Error | null = null;
    try {
      await backend.read(result.path);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();

    await rm(tmpDir, { recursive: true });
  });
});

// ── Entity with Asset() field ───────────────────────────────────

describe('entity with Asset() field', () => {
  function setupNoteRuntime() {
    registerHandlers();

    const note = define('note', {
      schema: {
        title: Str({ required: true }),
        image: Asset(),
      },
      storage: Persistent(),
    });

    const registry = compile([
      note, participate(note, {}),
      ...frameworkEntities, ...frameworkParticipations,
    ]);

    const memAdapter = createMemoryAdapter();
    const store = createEntityStore({
      routing: registry.persistRouting,
      adapters: { relational: memAdapter, memory: memAdapter },
    });

    const broker = createBroker();
    const backend = createLocalBackend({ directory: '/tmp/janus-test-assets', publicPath: '/assets' });
    const runtime = createDispatchRuntime({ registry, store, broker, assetBackend: backend });

    return { store, runtime };
  }

  test('Asset() field stores an ID referencing a real asset', async () => {
    const { store, runtime } = setupNoteRuntime();
    await store.initialize();

    // Create asset record first
    const assetResp = await runtime.dispatch('system', 'asset', 'create', {
      filename: 'photo.jpg',
      content_type: 'image/jpeg',
      size: 1024,
      backend: 'local',
      path: '2026-04/abc-photo.jpg',
      checksum: 'sha256:abc',
    }, SYSTEM);
    expect(assetResp.ok).toBe(true);
    const assetId = (assetResp.data as { id: string }).id;

    // Create note referencing that asset
    const resp = await runtime.dispatch('system', 'note', 'create', {
      title: 'My Note',
      image: assetId,
    }, SYSTEM);
    expect(resp.ok).toBe(true);
    // Create returns the raw ID (enrichment only happens on read)
    expect((resp.data as Record<string, unknown>).image).toBe(assetId);
  });

  test('Asset() field rejects nonexistent asset ID', async () => {
    const { store, runtime } = setupNoteRuntime();
    await store.initialize();

    const resp = await runtime.dispatch('system', 'note', 'create', {
      title: 'My Note',
      image: 'nonexistent-asset-id',
    }, SYSTEM);
    expect(resp.ok).toBe(false);
    expect(resp.error!.kind).toBe('validation-error');
    expect(resp.error!.message).toContain('nonexistent-asset-id');
  });

  test('Asset() field allows null/empty values', async () => {
    const { store, runtime } = setupNoteRuntime();
    await store.initialize();

    const resp = await runtime.dispatch('system', 'note', 'create', {
      title: 'Note without image',
    }, SYSTEM);
    expect(resp.ok).toBe(true);
  });

  test('Asset() field enriches to object on read', async () => {
    const { store, runtime } = setupNoteRuntime();
    await store.initialize();

    // Create asset
    const assetResp = await runtime.dispatch('system', 'asset', 'create', {
      filename: 'chart.png',
      content_type: 'image/png',
      size: 2048,
      backend: 'local',
      path: '2026-04/def-chart.png',
      checksum: 'sha256:def',
      alt: 'Budget chart',
    }, SYSTEM);
    const assetId = (assetResp.data as { id: string }).id;

    // Create note
    const noteResp = await runtime.dispatch('system', 'note', 'create', {
      title: 'Report',
      image: assetId,
    }, SYSTEM);
    const noteId = (noteResp.data as { id: string }).id;

    // Read note — image should be enriched
    const readResp = await runtime.dispatch('system', 'note', 'read', { id: noteId }, SYSTEM);
    expect(readResp.ok).toBe(true);
    const record = readResp.data as Record<string, unknown>;
    const image = record.image as Record<string, unknown>;
    expect(image.id).toBe(assetId);
    expect(image.url).toBe('/assets/2026-04/def-chart.png');
    expect(image.filename).toBe('chart.png');
    expect(image.content_type).toBe('image/png');
    expect(image.alt).toBe('Budget chart');
  });
});
