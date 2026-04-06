/**
 * Unit tests for createLocalBackend — local filesystem asset storage.
 *
 * Exercises: write, read, delete, url, checksums, streams,
 * filename normalization.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLocalBackend } from '..';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'janus-asset-test-'));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('createLocalBackend()', () => {
  test('write() stores file and returns path, size, checksum', async () => {
    const backend = createLocalBackend({ directory: tempDir });
    const data = new TextEncoder().encode('hello world');
    const meta = { filename: 'test.txt', contentType: 'text/plain' };

    const result = await backend.write(data, meta);

    expect(result.path).toBeDefined();
    expect(result.path).toContain('test.txt');
    expect(result.size).toBe(data.length);
    expect(result.checksum).toBeDefined();
  });

  test('write() checksum starts with "sha256:"', async () => {
    const backend = createLocalBackend({ directory: tempDir });
    const data = new TextEncoder().encode('checksum test');
    const meta = { filename: 'hash.txt', contentType: 'text/plain' };

    const result = await backend.write(data, meta);

    expect(result.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('write() size matches input length', async () => {
    const backend = createLocalBackend({ directory: tempDir });
    const content = 'exact length test content';
    const data = new TextEncoder().encode(content);
    const meta = { filename: 'size.txt', contentType: 'text/plain' };

    const result = await backend.write(data, meta);

    expect(result.size).toBe(data.length);
  });

  test('read() returns the written bytes', async () => {
    const backend = createLocalBackend({ directory: tempDir });
    const data = new TextEncoder().encode('read me back');
    const meta = { filename: 'readable.txt', contentType: 'text/plain' };

    const { path } = await backend.write(data, meta);
    const readBack = await backend.read(path);

    expect(new TextDecoder().decode(readBack)).toBe('read me back');
  });

  test('delete() removes the file (no error)', async () => {
    const backend = createLocalBackend({ directory: tempDir });
    const data = new TextEncoder().encode('delete me');
    const meta = { filename: 'deletable.txt', contentType: 'text/plain' };

    const { path } = await backend.write(data, meta);

    // Should not throw
    await backend.delete(path);

    // Reading after delete should throw
    try {
      await backend.read(path);
      expect(true).toBe(false); // should not reach
    } catch {
      // expected
    }
  });

  test('delete() does not throw for missing file', async () => {
    const backend = createLocalBackend({ directory: tempDir });

    // Should not throw for non-existent file
    await backend.delete('non/existent/path.txt');
  });

  test('url() returns publicPath + path', async () => {
    const backend = createLocalBackend({ directory: tempDir, publicPath: '/files' });

    const url = backend.url('2026-04/abc-test.txt');
    expect(url).toBe('/files/2026-04/abc-test.txt');
  });

  test('url() uses default "/assets" when no publicPath configured', async () => {
    const backend = createLocalBackend({ directory: tempDir });

    const url = backend.url('2026-04/abc-test.txt');
    expect(url).toBe('/assets/2026-04/abc-test.txt');
  });

  test('write() from ReadableStream works', async () => {
    const backend = createLocalBackend({ directory: tempDir });
    const content = 'streamed data content';
    const encoded = new TextEncoder().encode(content);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });

    const meta = { filename: 'streamed.txt', contentType: 'text/plain' };
    const result = await backend.write(stream, meta);

    expect(result.size).toBe(encoded.length);

    const readBack = await backend.read(result.path);
    expect(new TextDecoder().decode(readBack)).toBe(content);
  });

  test('filename normalization: special characters replaced with underscores', async () => {
    const backend = createLocalBackend({ directory: tempDir });
    const data = new TextEncoder().encode('special chars');
    const meta = { filename: 'my file (1) [test].txt', contentType: 'text/plain' };

    const result = await backend.write(data, meta);

    // Spaces, parens, brackets → underscores
    expect(result.path).toContain('my_file__1___test_.txt');
  });
});
