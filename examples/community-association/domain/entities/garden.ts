/**
 * Community garden entities: garden_bed, garden_assignment, garden_log
 */
import { define } from '@janus/core';
import {
  Str, Int, DateTime, Public, Persistent, Relation,
} from '@janus/vocabulary';
import {
  gardenBedLifecycle, gardenAssignmentLifecycle, gardenLogLifecycle,
} from '../lifecycles';

// ── Garden Bed ────────────────────────────────────────────────────
export const garden_bed = define('garden_bed', {
  schema: Public({
    label: Str({ required: true, as: 'title' }),
    ring: Str({ as: 'subtitle' }),
    position: Int(),
    facilityId: Relation('facility'),
    status: gardenBedLifecycle,
  }),
  storage: Persistent(),
  description: 'Individual garden bed within a facility',
});

// ── Garden Assignment ─────────────────────────────────────────────
export const garden_assignment = define('garden_assignment', {
  schema: Public({
    gardenBedId: Relation('garden_bed'),
    assigneeName: Str({ required: true, as: 'title' }),
    plants: Str({ as: 'subtitle' }),
    season: Int(),
    memberSince: Int(),
    notes: Str(),
    status: gardenAssignmentLifecycle,
  }),
  storage: Persistent(),
  description: 'Garden bed assignment to a member',
});

// ── Garden Log ────────────────────────────────────────────────────
export const garden_log = define('garden_log', {
  schema: Public({
    gardenAssignmentId: Relation('garden_assignment'),
    type: Str({ required: true, as: 'subtitle' }),
    description: Str({ required: true, as: 'title' }),
    loggedAt: DateTime({ required: true }),
    quantity: Str(),
    status: gardenLogLifecycle,
  }),
  storage: Persistent(),
  description: 'Garden activity log entry',
});
