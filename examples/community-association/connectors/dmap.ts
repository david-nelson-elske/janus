/**
 * Calgary DMap connectors — sync planning cases from ArcGIS Feature Server.
 *
 * Uses the proper framework connector pattern:
 * - Singleton connector entity with config + checkpoint
 * - sync action with connector_binding for ID mapping
 * - mergeOnIngest for field ownership (source vs local fields)
 * - dispatch-adapter + tracked cron subscriptions
 */
import { define, participate, subscribe } from '@janus/core';
import type { ExecutionHandler, ReadPage } from '@janus/core';
import { SYSTEM } from '@janus/core';
import { Str, Json, Enum, Singleton } from '@janus/vocabulary';
import { mergeOnIngest } from '@janus/pipeline';
import type { FieldOwnershipMap } from '@janus/pipeline';
import { config } from '../config';

// ── ArcGIS types ──────────────────────────────────────────────────

interface ArcGISFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number; rings?: number[][][] };
}

interface ArcGISQueryResult {
  features: ArcGISFeature[];
}

// ── Helpers ───────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function extractLatLng(geom?: { x?: number; y?: number; rings?: number[][][] }): { lat: number; lng: number } | null {
  if (!geom) return null;
  if (geom.x !== undefined && geom.y !== undefined) {
    return { lat: geom.y, lng: geom.x };
  }
  if (geom.rings && geom.rings.length > 0) {
    const ring = geom.rings[0];
    let sumLat = 0, sumLng = 0;
    for (const [lng, lat] of ring) {
      sumLng += lng;
      sumLat += lat;
    }
    return { lat: sumLat / ring.length, lng: sumLng / ring.length };
  }
  return null;
}

function buildCommentUrl(fileNumber: string, address: string, fileManagerEmail: string): string {
  const params = new URLSearchParams({ fileNumber, address, fileManagerEmail });
  return `https://developmentmap.calgary.ca/public-comment?${params}`;
}

function twoYearsAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  return d.toISOString().split('T')[0];
}

// ── Field ownership ───────────────────────────────────────────────
// Source-owned: fields that come from ArcGIS — external data always wins
// Local-owned: fields that are community-managed (responses, committee status)

const FIELD_OWNERSHIP: FieldOwnershipMap = Object.freeze({
  title: 'source',
  description: 'source',
  externalType: 'source',
  fileNumber: 'source',
  statusDescription: 'source',
  applicant: 'source',
  createdAtExternal: 'source',
  cityCaseUrl: 'source',
  cityCommentUrl: 'source',
  existingLud: 'source',
  existingLudDescription: 'source',
  proposedLud: 'source',
  decisionAtExternal: 'source',
  externalSource: 'source',
  jobId: 'source',
  communityName: 'source',
  statusTag: 'source',
  fileManagerName: 'source',
  fileManagerEmail: 'source',
  fileManagerTitle: 'source',
  relevanceScope: 'source',
  appealBody: 'source',
  location: 'source',
  lastSyncedAt: 'source',
  // Local-owned — community edits these, external sync must not overwrite
  responseDisposition: 'local',
  responseComment: 'local',
  responseDocument: 'local',
  responseSubmitted: 'local',
  responseRespondedAt: 'local',
  responseEditedAt: 'local',
  committeeStatus: 'local',
  plainLanguageSummary: 'local',
  image: 'local',
});

// ── Mapping functions ─────────────────────────────────────────────

function mapRedesignation(feature: ArcGISFeature): Record<string, unknown> {
  const a = feature.attributes;
  const fileNumber = str(a.FILENUM);
  const address = str(a.ADDRESS);
  const fileManagerEmail = str(a.FILEMANAGEREMAIL);
  const location = extractLatLng(feature.geometry);

  const mapped: Record<string, unknown> = {
    externalSource: 'dmap',
    fileNumber,
    jobId: str(a.JOBID),
    title: address || fileNumber,
    description: str(a.DESCRIPTION),
    communityName: str(a.COMMUNITYNAME),
    statusTag: str(a.STATUSTAG),
    statusDescription: str(a.STATUSDESCRIPTION),
    applicant: str(a.APPLICANT),
    fileManagerName: str(a.FILEMANAGERNAME),
    fileManagerEmail,
    fileManagerTitle: '',
    createdAtExternal: a.CREATEDDATE ? new Date(a.CREATEDDATE as number).toISOString() : undefined,
    cityCaseUrl: `https://developmentmap.calgary.ca/redesignation/${fileNumber}`,
    cityCommentUrl: fileManagerEmail ? buildCommentUrl(fileNumber, address, fileManagerEmail) : undefined,
    existingLud: str(a.EXISTINGLUD),
    proposedLud: str(a.PROPOSEDLUD),
    externalType: 'redesignation',
    relevanceScope: 'community',
    lastSyncedAt: new Date().toISOString(),
  };
  if (location) mapped.location = location;
  return mapped;
}

function mapPermit(feature: ArcGISFeature): Record<string, unknown> {
  const a = feature.attributes;
  const fileNumber = str(a.FILENUM);
  const address = str(a.ADDRESS);
  const location = extractLatLng(feature.geometry);

  const mapped: Record<string, unknown> = {
    externalSource: 'dmap',
    fileNumber,
    jobId: str(a.JOBID),
    title: address || fileNumber,
    description: str(a.DESCRIPTION),
    communityName: str(a.COMMUNITYNAME),
    statusTag: str(a.STATUSTAG),
    statusDescription: str(a.STATUSDESCRIPTION),
    applicant: str(a.APPLICANT),
    fileManagerName: str(a.FILEMANAGERNAME),
    fileManagerEmail: str(a.FILEMANAGEREMAIL),
    fileManagerTitle: str(a.FILEMANAGERTITLE),
    createdAtExternal: a.CREATEDDATE ? new Date(a.CREATEDDATE as number).toISOString() : undefined,
    decisionAtExternal: a.DECISIONDATE ? new Date(a.DECISIONDATE as number).toISOString() : undefined,
    cityCaseUrl: `https://developmentmap.calgary.ca/dp/${fileNumber}`,
    existingLud: str(a.EXISTINGLUD),
    existingLudDescription: str(a.EXISTINGLUDDESCRIPTION),
    proposedLud: str(a.PROPOSEDLUD),
    appealBody: str(a.APPEALBODY),
    externalType: 'development-permit',
    relevanceScope: 'spatial',
    lastSyncedAt: new Date().toISOString(),
  };
  if (location) mapped.location = location;
  return mapped;
}

// ── Shared sync logic ─────────────────────────────────────────────

async function syncFeatures(
  ctx: Parameters<ExecutionHandler>[0],
  connectorName: string,
  features: ArcGISFeature[],
  mapFn: (f: ArcGISFeature) => Record<string, unknown>,
): Promise<{ processed: number; created: number; updated: number }> {
  const dispatch = ctx._dispatch!;
  const stats = { processed: 0, created: 0, updated: 0 };

  for (const feature of features) {
    const fileNumber = str(feature.attributes.FILENUM);
    if (!fileNumber) continue;
    stats.processed++;

    const mapped = mapFn(feature);
    const watermark = String(feature.attributes.LOAD_DATE ?? '');

    // Look up existing binding
    const bindingPage = await ctx.store.read('connector_binding', {
      where: { connector: connectorName, entity: 'planning_case', externalId: fileNumber },
    }) as ReadPage;

    if (bindingPage.records.length > 0) {
      const binding = bindingPage.records[0];
      const localId = binding.localId as string;

      // Read current local record for merge
      const localResult = await dispatch('planning_case', 'read', { id: localId }, SYSTEM);
      const localRecord = (localResult as { data?: Record<string, unknown> })?.data;

      if (localRecord) {
        // Merge: source-owned fields overwrite, local-owned fields preserved
        const { merged, changed } = mergeOnIngest(
          localRecord as Record<string, unknown>,
          mapped,
          FIELD_OWNERSHIP,
        );

        if (changed.length > 0) {
          await dispatch('planning_case', 'update', { id: localId, ...merged }, SYSTEM);
        }
      }

      // Update binding watermark
      await dispatch('connector_binding', 'update', {
        id: binding.id as string,
        lastSyncedAt: new Date().toISOString(),
        watermark,
      }, SYSTEM);
      stats.updated++;
    } else {
      // Create new planning case + binding
      const result = await dispatch('planning_case', 'create', mapped, SYSTEM);
      const newId = (result as { data?: { id: string } })?.data?.id;

      if (newId) {
        await dispatch('connector_binding', 'create', {
          connector: connectorName,
          entity: 'planning_case',
          localId: newId,
          externalId: fileNumber,
          externalSource: 'dmap',
          direction: 'ingest',
          lastSyncedAt: new Date().toISOString(),
          watermark,
          fieldOwnership: FIELD_OWNERSHIP,
        }, SYSTEM);
      }
      stats.created++;
    }
  }

  return stats;
}

// ── Connector entities ────────────────────────────────────────────

export const dmap_redesignations = define('dmap_redesignations', {
  schema: {
    endpoint: Str({ required: true }),
    checkpoint: Json(),
    connectorStatus: Enum(['active', 'paused', 'error']),
  },
  storage: Singleton({
    defaults: {
      endpoint: 'https://services1.arcgis.com/AVP60cs0Q9PEA8rH/arcgis/rest/services/Development_Map_Land_Use_Redesignations/FeatureServer/0/query',
      connectorStatus: 'active',
    },
  }),
  description: 'DMap land use redesignation connector config',
});

export const dmap_permits = define('dmap_permits', {
  schema: {
    endpoint: Str({ required: true }),
    checkpoint: Json(),
    connectorStatus: Enum(['active', 'paused', 'error']),
  },
  storage: Singleton({
    defaults: {
      endpoint: 'https://services1.arcgis.com/AVP60cs0Q9PEA8rH/arcgis/rest/services/Development_Map_DPs/FeatureServer/0/query',
      connectorStatus: 'active',
    },
  }),
  description: 'DMap development permit connector config',
});

// ── Sync action handlers ──────────────────────────────────────────

const redesignationsSyncHandler: ExecutionHandler = async (ctx) => {
  // Read connector config
  const configPage = await ctx.store.read('dmap_redesignations', {}) as ReadPage;
  const connConfig = configPage.records[0];
  if (!connConfig || connConfig.connectorStatus === 'paused') {
    ctx.result = { kind: 'output', data: { skipped: true } };
    return;
  }

  const communities = config.connectors?.arcgis?.communities ?? ['PARKDALE'];
  const communityFilter = communities.map(c => `'${c}'`).join(',');
  const since = twoYearsAgo();

  const url = new URL(connConfig.endpoint as string);
  url.searchParams.set('where', `COMMUNITYNAME IN (${communityFilter}) AND CREATEDDATE >= '${since}'`);
  url.searchParams.set('outFields', '*');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'json');

  const res = await fetch(url.toString());
  const data = await res.json() as ArcGISQueryResult;
  console.log(`[dmap-redesignations] Fetched ${data.features?.length ?? 0} features`);

  const stats = await syncFeatures(ctx, 'dmap_redesignations', data.features ?? [], mapRedesignation);

  // Update checkpoint
  await ctx._dispatch!('dmap_redesignations', 'update', {
    id: connConfig.id,
    checkpoint: { syncedAt: new Date().toISOString(), ...stats },
  }, SYSTEM);

  ctx.result = { kind: 'output', data: stats };
};

const permitsSyncHandler: ExecutionHandler = async (ctx) => {
  const configPage = await ctx.store.read('dmap_permits', {}) as ReadPage;
  const connConfig = configPage.records[0];
  if (!connConfig || connConfig.connectorStatus === 'paused') {
    ctx.result = { kind: 'output', data: { skipped: true } };
    return;
  }

  const since = twoYearsAgo();
  const boundary = config.connectors?.arcgis?.boundary ?? {
    type: 'Polygon' as const,
    coordinates: [[
      [-114.15513, 51.06630], [-114.12779, 51.06630],
      [-114.12779, 51.05478], [-114.15513, 51.05478],
      [-114.15513, 51.06630],
    ]],
  };

  const url = new URL(connConfig.endpoint as string);
  url.searchParams.set('where', `CREATEDDATE >= '${since}'`);
  url.searchParams.set('geometry', JSON.stringify(boundary));
  url.searchParams.set('geometryType', 'esriGeometryPolygon');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('outFields', '*');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'json');

  const res = await fetch(url.toString());
  const data = await res.json() as ArcGISQueryResult;
  console.log(`[dmap-permits] Fetched ${data.features?.length ?? 0} features`);

  const stats = await syncFeatures(ctx, 'dmap_permits', data.features ?? [], mapPermit);

  await ctx._dispatch!('dmap_permits', 'update', {
    id: connConfig.id,
    checkpoint: { syncedAt: new Date().toISOString(), ...stats },
  }, SYSTEM);

  ctx.result = { kind: 'output', data: stats };
};

// ── Participation (wires sync actions) ────────────────────────────

export const dmapRedesignationsParticipation = participate(dmap_redesignations, {
  actions: {
    sync: {
      handler: redesignationsSyncHandler,
      kind: 'effect',
      description: 'Pull land use redesignation data from Calgary DMap ArcGIS',
    },
  },
});

export const dmapPermitsParticipation = participate(dmap_permits, {
  actions: {
    sync: {
      handler: permitsSyncHandler,
      kind: 'effect',
      description: 'Pull development permit data from Calgary DMap ArcGIS',
    },
  },
});

// ── Cron subscriptions (tracked, via dispatch-adapter) ────────────

export const dmapRedesignationsSchedule = subscribe(dmap_redesignations, [
  {
    cron: '0 7 * * 1-5',
    handler: 'dispatch-adapter',
    config: { entity: 'dmap_redesignations', action: 'sync' },
    tracked: true,
    failure: 'retry',
    retry: { max: 3, backoff: 'exponential', initialDelay: 5000 },
  },
]);

export const dmapPermitsSchedule = subscribe(dmap_permits, [
  {
    cron: '5 7 * * 1-5',
    handler: 'dispatch-adapter',
    config: { entity: 'dmap_permits', action: 'sync' },
    tracked: true,
    failure: 'retry',
    retry: { max: 3, backoff: 'exponential', initialDelay: 5000 },
  },
]);
