/**
 * AssetBackend — local filesystem implementation (ADR 08b).
 *
 * Interface types (AssetBackend, AssetMeta, AssetWriteResult) live in core/types.ts.
 * This file provides the local filesystem backend and re-exports the types.
 */

import type { AssetBackend, AssetMeta, AssetWriteResult } from '@janus/core';
import { createHash } from 'crypto';
import { mkdir, writeFile, unlink, readFile } from 'fs/promises';
import { join, dirname } from 'path';

export type { AssetBackend, AssetMeta, AssetWriteResult };

export interface LocalBackendConfig {
  readonly directory: string;
  readonly publicPath?: string;
}

/**
 * Local filesystem asset backend.
 * Files stored at: {directory}/{YYYY-MM}/{uuid}-{filename}
 */
export function createLocalBackend(config: LocalBackendConfig): AssetBackend {
  const publicPath = config.publicPath ?? '/assets';

  return {
    async write(data, meta) {
      const now = new Date();
      const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const id = crypto.randomUUID();
      const safeName = meta.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const relativePath = `${monthDir}/${id}-${safeName}`;
      const fullPath = join(config.directory, relativePath);

      await mkdir(dirname(fullPath), { recursive: true });

      let bytes: Uint8Array;
      if (data instanceof Uint8Array) {
        bytes = data;
      } else {
        // Read stream to buffer
        const chunks: Uint8Array[] = [];
        const reader = data.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        bytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      }

      await writeFile(fullPath, bytes);

      const hash = createHash('sha256');
      hash.update(bytes);
      const checksum = `sha256:${hash.digest('hex')}`;

      return { path: relativePath, size: bytes.length, checksum };
    },

    url(path) {
      return `${publicPath}/${path}`;
    },

    async delete(path) {
      const fullPath = join(config.directory, path);
      try {
        await unlink(fullPath);
      } catch {
        // File may already be gone
      }
    },

    async read(path) {
      const fullPath = join(config.directory, path);
      return readFile(fullPath);
    },
  };
}
