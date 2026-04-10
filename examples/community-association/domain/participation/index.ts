/**
 * All participation records for the community association.
 */
export {
  userParticipation, facilityParticipation, seriesParticipation,
  sessionParticipation, registrationParticipation,
  membershipParticipation, membershipTierParticipation,
} from './core';
export { orderParticipation, paymentParticipation } from './payments';
export { contentParticipation, newsItemParticipation } from './content';
export {
  committeeParticipation, committeeTermParticipation,
  committeeResponseParticipation, planningCaseParticipation,
} from './governance';
export {
  taskParticipation, volunteerProfileParticipation,
  volunteerPositionParticipation, volunteerAssignmentParticipation,
  sessionTicketParticipation,
} from './operations';
export {
  gardenBedParticipation, gardenAssignmentParticipation,
  gardenLogParticipation,
} from './garden';

import {
  userParticipation, facilityParticipation, seriesParticipation,
  sessionParticipation, registrationParticipation,
  membershipParticipation, membershipTierParticipation,
} from './core';
import { orderParticipation, paymentParticipation } from './payments';
import { contentParticipation, newsItemParticipation } from './content';
import {
  committeeParticipation, committeeTermParticipation,
  committeeResponseParticipation, planningCaseParticipation,
} from './governance';
import {
  taskParticipation, volunteerProfileParticipation,
  volunteerPositionParticipation, volunteerAssignmentParticipation,
  sessionTicketParticipation,
} from './operations';
import {
  gardenBedParticipation, gardenAssignmentParticipation,
  gardenLogParticipation,
} from './garden';

/** All participation records — pass to compile(). */
export const allParticipations = [
  // Core
  userParticipation, facilityParticipation, seriesParticipation,
  sessionParticipation, registrationParticipation,
  membershipParticipation, membershipTierParticipation,
  // Payments
  orderParticipation, paymentParticipation,
  // Content
  contentParticipation, newsItemParticipation,
  // Governance
  committeeParticipation, committeeTermParticipation,
  committeeResponseParticipation, planningCaseParticipation,
  // Operations
  taskParticipation, volunteerProfileParticipation,
  volunteerPositionParticipation, volunteerAssignmentParticipation,
  sessionTicketParticipation,
  // Garden
  gardenBedParticipation, gardenAssignmentParticipation,
  gardenLogParticipation,
] as const;
