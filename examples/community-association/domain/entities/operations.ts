/**
 * Operations entities: task, volunteer_profile, volunteer_position,
 * volunteer_assignment, session_ticket
 */
import { define } from '@janus/core';
import {
  Str, Int, DateTime, Markdown, Scope, QrCode,
  Private, Public, Persistent, Relation,
} from '@janus/vocabulary';
import {
  taskLifecycle, volunteerProfileLifecycle, volunteerPositionLifecycle,
  volunteerAssignmentLifecycle, sessionTicketLifecycle,
} from '../lifecycles';

// ── Task ──────────────────────────────────────────────────────────
export const task = define('task', {
  schema: Private({
    title: Str({ required: true, as: 'title' }),
    description: Markdown({ as: 'body' }),
    dueAt: DateTime({ as: 'timestamp' }),
    scope: Scope(),
    ownerId: Relation('user'),
    status: taskLifecycle,
  }),
  storage: Persistent(),
  description: 'Operational task with visibility scope',
  owned: true,
});

// ── Volunteer Profile ─────────────────────────────────────────────
export const volunteer_profile = define('volunteer_profile', {
  schema: Private({
    userId: Relation('user'),
    interests: Str({ required: true }),
    skills: Str(),
    availabilityNotes: Str(),
    status: volunteerProfileLifecycle,
  }),
  storage: Persistent(),
  description: 'Volunteer profile with interests and availability',
  owned: true,
});

// ── Volunteer Position ────────────────────────────────────────────
export const volunteer_position = define('volunteer_position', {
  schema: Public({
    title: Str({ required: true, as: 'title' }),
    description: Markdown({ as: 'body' }),
    slotsNeeded: Int(),
    requirements: Markdown(),
    seriesId: Relation('series', {
      effects: { transitioned: { cancelled: 'cascade' } },
    }),
    status: volunteerPositionLifecycle,
  }),
  storage: Persistent(),
  description: 'Open volunteer position',
});

// ── Volunteer Assignment ──────────────────────────────────────────
export const volunteer_assignment = define('volunteer_assignment', {
  schema: Private({
    userId: Relation('user'),
    positionId: Relation('volunteer_position', {
      effects: { transitioned: { cancelled: 'cascade' } },
    }),
    sessionId: Relation('session'),
    hoursLogged: Int(),
    notes: Str(),
    status: volunteerAssignmentLifecycle,
  }),
  storage: Persistent(),
  description: 'Volunteer assigned to a position',
  owned: true,
});

// ── Session Ticket ────────────────────────────────────────────────
export const session_ticket = define('session_ticket', {
  schema: Private({
    registrationId: Relation('registration', {
      cascade: 'cascade',
      effects: { transitioned: { cancelled: 'cascade' } },
    }),
    sessionId: Relation('session', {
      cascade: 'cascade',
      effects: { transitioned: { cancelled: 'cascade' } },
    }),
    ticketQr: QrCode({ singleUse: true }),
    checkedInAt: DateTime({ as: 'timestamp' }),
    checkedInBy: Str(),
    notes: Str(),
    status: sessionTicketLifecycle,
  }),
  storage: Persistent(),
  description: 'QR-based attendance ticket for a session',
  owned: true,
});
