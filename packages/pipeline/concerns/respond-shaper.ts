/**
 * respond-shaper — Shape dispatch result into response format.
 *
 * Order=70, non-transactional (postTx). Enriches Asset() field values
 * from bare IDs to { id, url, filename, content_type, alt } objects.
 *
 * UPDATE @ ADR 08b: Asset field enrichment on read results.
 */

import type { ExecutionHandler, EntityRecord, ReadPage } from '@janus/core';
import { isReadPage } from '@janus/core';

export const respondShaper: ExecutionHandler = async (ctx) => {
  if (!ctx.result || ctx.operation !== 'read') return;

  // Find Asset() fields in the entity schema
  const entity = ctx.registry.entity(ctx.entity);
  if (!entity) return;

  const assetFields: string[] = [];
  for (const [field, def] of Object.entries(entity.schema)) {
    if ('kind' in def && def.kind === 'asset') {
      assetFields.push(field);
    }
  }
  if (assetFields.length === 0) return;

  // Collect asset IDs from the result
  const enrichRecord = async (record: Record<string, unknown>) => {
    for (const field of assetFields) {
      const assetId = record[field];
      if (typeof assetId !== 'string' || assetId.length === 0) continue;

      const assetRecord = await ctx.store.read('asset', { id: assetId });
      if (!assetRecord || isReadPage(assetRecord)) continue;

      const ar = assetRecord as EntityRecord;
      record[field] = {
        id: ar.id,
        url: ctx.assetBackend ? ctx.assetBackend.url(ar.path as string) : ar.path,
        filename: ar.filename,
        content_type: ar.content_type,
        alt: ar.alt ?? null,
      };
    }
  };

  if (ctx.result.kind === 'record') {
    const mutable = { ...ctx.result.record } as Record<string, unknown>;
    await enrichRecord(mutable);
    ctx.result = { kind: 'record', record: mutable as EntityRecord };
  } else if (ctx.result.kind === 'page') {
    const page = ctx.result.page;
    const enriched = await Promise.all(
      page.records.map(async (r) => {
        const mutable = { ...r } as Record<string, unknown>;
        await enrichRecord(mutable);
        return mutable as EntityRecord;
      }),
    );
    ctx.result = {
      kind: 'page',
      page: { ...page, records: enriched },
    };
  }
};
