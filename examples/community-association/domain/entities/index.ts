/**
 * All entity definitions for the community association.
 */
export { user, facility, series, session, registration, membership, membership_tier } from './core';
export { order, payment } from './payments';
export { content, news_item } from './content';
export { committee, committee_term, committee_response, planning_case } from './governance';
export { task, volunteer_profile, volunteer_position, volunteer_assignment, session_ticket } from './operations';
export { garden_bed, garden_assignment, garden_log } from './garden';

import { user, facility, series, session, registration, membership, membership_tier } from './core';
import { order, payment } from './payments';
import { content, news_item } from './content';
import { committee, committee_term, committee_response, planning_case } from './governance';
import { task, volunteer_profile, volunteer_position, volunteer_assignment, session_ticket } from './operations';
import { garden_bed, garden_assignment, garden_log } from './garden';

/** All entity definitions — pass to compile(). */
export const allDefinitions = [
  // Core
  user, facility, series, session, registration, membership, membership_tier,
  // Payments
  order, payment,
  // Content
  content, news_item,
  // Governance
  committee, committee_term, committee_response, planning_case,
  // Operations
  task, volunteer_profile, volunteer_position, volunteer_assignment, session_ticket,
  // Garden
  garden_bed, garden_assignment, garden_log,
] as const;
