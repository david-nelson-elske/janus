/**
 * Connector declarations — entities, participations, and subscriptions
 * for all connectors. These must be included in compile().
 */
export {
  dmap_redesignations, dmap_permits,
  dmapRedesignationsParticipation, dmapPermitsParticipation,
  dmapRedesignationsSchedule, dmapPermitsSchedule,
} from './dmap';

import {
  dmap_redesignations, dmap_permits,
  dmapRedesignationsParticipation, dmapPermitsParticipation,
  dmapRedesignationsSchedule, dmapPermitsSchedule,
} from './dmap';

/** All connector declarations — pass to compile(). */
export const allConnectorDeclarations = [
  // Entities
  dmap_redesignations, dmap_permits,
  // Participations (wires sync actions)
  dmapRedesignationsParticipation, dmapPermitsParticipation,
  // Cron subscriptions
  dmapRedesignationsSchedule, dmapPermitsSchedule,
] as const;
