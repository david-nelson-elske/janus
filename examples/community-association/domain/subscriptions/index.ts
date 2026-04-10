/**
 * All subscription records for the community association.
 *
 * Note: DMap connector subscriptions are in connectors/dmap.ts (colocated with
 * their Singleton entities and sync actions — the proper connector pattern).
 */
export { membershipSubscriptions } from './membership';
export { orderSubscriptions } from './order';
export { planningCaseSubscriptions } from './planning';
export {
  news_connector, newsConnectorParticipation, newsSchedule,
  membershipExpirySchedule, sessionTicketSchedule,
} from './schedules';

import { membershipSubscriptions } from './membership';
import { orderSubscriptions } from './order';
import { planningCaseSubscriptions } from './planning';
import {
  news_connector, newsConnectorParticipation, newsSchedule,
  membershipExpirySchedule, sessionTicketSchedule,
} from './schedules';

/** All subscription records — pass to compile(). */
export const allSubscriptions = [
  membershipSubscriptions,
  orderSubscriptions,
  planningCaseSubscriptions,
  newsSchedule,
  membershipExpirySchedule,
  sessionTicketSchedule,
] as const;

/** News connector declarations — must also be passed to compile(). */
export const newsConnectorDeclarations = [
  news_connector,
  newsConnectorParticipation,
] as const;
