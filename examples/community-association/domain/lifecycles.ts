/**
 * Lifecycle transition maps for all community association entities.
 *
 * Pure state machines — no auth. Auth is expressed via Policy() in participation.
 * First key in each map is the initial state.
 */
import { Lifecycle } from '@janus/vocabulary';

// ── Facility ──────────────────────────────────────────────
export const facilityLifecycle = Lifecycle({
  draft: ['active'],
  active: ['inactive'],
  inactive: ['active'],
});

// ── Series (events/programs) ──────────────────────────────
export const seriesLifecycle = Lifecycle({
  draft: ['published'],
  published: ['cancelled', 'completed'],
  cancelled: [],
  completed: [],
});

// ── Session (individual occurrence) ───────────────────────
export const sessionLifecycle = Lifecycle({
  scheduled: ['cancelled'],
  cancelled: [],
});

// ── Registration ──────────────────────────────────────────
export const registrationLifecycle = Lifecycle({
  pending: ['confirmed', 'cancelled'],
  confirmed: ['cancelled'],
  cancelled: [],
});

// ── Content (announcements/blog) ──────────────────────────
export const contentLifecycle = Lifecycle({
  draft: ['published'],
  published: ['archived', 'draft'],
  archived: [],
});

// ── Membership ────────────────────────────────────────────
export const membershipLifecycle = Lifecycle({
  pending: ['active', 'cancelled'],
  active: ['expired', 'cancelled'],
  expired: ['active'],
  cancelled: [],
});

// ── Membership Tier ───────────────────────────────────────
export const membershipTierLifecycle = Lifecycle({
  active: ['archived'],
  archived: ['active'],
});

// ── Order ─────────────────────────────────────────────────
export const orderLifecycle = Lifecycle({
  pending: ['fulfilled', 'failed', 'cancelled'],
  fulfilled: ['refunded'],
  failed: [],
  cancelled: [],
  refunded: [],
});

// ── Payment ───────────────────────────────────────────────
export const paymentLifecycle = Lifecycle({
  pending: ['captured', 'failed'],
  captured: [],
  failed: [],
});

// ── User ──────────────────────────────────────────────────
export const userLifecycle = Lifecycle({
  active: ['inactive'],
  inactive: ['active'],
});

// ── Document ──────────────────────────────────────────────
export const documentLifecycle = Lifecycle({
  active: ['archived'],
  archived: ['active'],
});

// ── Planning Case ─────────────────────────────────────────
export const planningCaseLifecycle = Lifecycle({
  active: ['stale', 'archived'],
  stale: ['active', 'archived'],
  archived: [],
});

// ── News Item ─────────────────────────────────────────────
export const newsItemLifecycle = Lifecycle({
  active: ['stale', 'archived'],
  stale: ['active', 'archived'],
  archived: [],
});

// ── Committee ─────────────────────────────────────────────
export const committeeLifecycle = Lifecycle({
  active: ['inactive'],
  inactive: ['active'],
});

// ── Committee Term ────────────────────────────────────────
export const committeeTermLifecycle = Lifecycle({
  active: ['inactive'],
  inactive: ['active'],
});

// ── Committee Response ────────────────────────────────────
export const committeeResponseLifecycle = Lifecycle({
  draft: ['published'],
  published: ['draft', 'archived'],
  archived: [],
});

// ── Task ──────────────────────────────────────────────────
export const taskLifecycle = Lifecycle({
  open: ['in_progress', 'completed', 'deferred', 'cancelled'],
  in_progress: ['completed', 'deferred', 'cancelled'],
  completed: ['open'],
  deferred: ['open', 'cancelled'],
  cancelled: [],
});

// ── Session Ticket ────────────────────────────────────────
export const sessionTicketLifecycle = Lifecycle({
  active: ['recorded', 'cancelled'],
  recorded: [],
  cancelled: [],
});

// ── Volunteer Profile ─────────────────────────────────────
export const volunteerProfileLifecycle = Lifecycle({
  active: ['inactive'],
  inactive: ['active'],
});

// ── Volunteer Position ────────────────────────────────────
export const volunteerPositionLifecycle = Lifecycle({
  draft: ['active'],
  active: ['inactive', 'cancelled'],
  inactive: ['active'],
  cancelled: [],
});

// ── Volunteer Assignment ──────────────────────────────────
export const volunteerAssignmentLifecycle = Lifecycle({
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
});

// ── Garden Bed ────────────────────────────────────────────
export const gardenBedLifecycle = Lifecycle({
  active: ['inactive'],
  inactive: ['active'],
});

// ── Garden Assignment ─────────────────────────────────────
export const gardenAssignmentLifecycle = Lifecycle({
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
});

// ── Garden Log ────────────────────────────────────────────
export const gardenLogLifecycle = Lifecycle({
  active: ['archived'],
  archived: [],
});
