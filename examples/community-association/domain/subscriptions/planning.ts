/**
 * Planning case subscriptions — pre-render static map image on create.
 */
import { subscribe, handler, Created, SYSTEM } from '@janus/core';
import { planning_case } from '../entities';
import type { ConcernContext } from '@janus/core';

handler('planning-case-map-render', async (ctx: ConcernContext) => {
  const { entityId } = ctx.input as { entityId: string };
  const dispatch = ctx._dispatch!;

  const result = await dispatch('planning_case', 'read', { id: entityId }, SYSTEM);
  const data = (result as { data?: Record<string, unknown> })?.data;
  if (!data) return;

  const location = data.location as { lat: number; lng: number } | undefined;
  if (!location) {
    console.log(`[planning-case] No location for ${entityId}, skipping map render`);
    return;
  }

  // Pre-render static map tile (best-effort)
  // This would use MapTiler or similar static map API
  console.log(`[planning-case] Map render for ${entityId} at ${location.lat},${location.lng} — TODO`);
}, 'Pre-render static map image for planning case');

// ── Subscriptions ──────────────────────────────────────────────────

export const planningCaseSubscriptions = subscribe(planning_case, [
  {
    on: Created,
    handler: 'planning-case-map-render',
    config: {},
    failure: 'log',
  },
]);
