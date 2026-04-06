/**
 * Proof entities — ready-made entity definitions for testing.
 *
 * Covers: Str, Int, Markdown, DateTime, Lifecycle, Relation, Reference,
 * Enum, Persistent storage, owned entities.
 */

import { define, participate } from '@janus/core';
import type { DeclarationRecord } from '@janus/core';
import {
  Str, Int, Markdown, DateTime, Enum,
  Lifecycle, Relation, Reference,
  Persistent,
} from '@janus/vocabulary';

// ── Entity definitions ─────────────────────────────────────────

export const User = define('user', {
  schema: {
    name: Str({ required: true }),
    email: Str(),
    role: Enum(['admin', 'member', 'guest']),
    status: Lifecycle({
      active: ['suspended', 'archived'],
      suspended: ['active'],
    }),
  },
  storage: Persistent(),
  description: 'Test user entity',
});

export const Venue = define('venue', {
  schema: {
    name: Str({ required: true }),
    address: Str(),
    capacity: Int(),
    status: Lifecycle({
      active: ['archived'],
    }),
  },
  storage: Persistent(),
  description: 'Test venue entity',
});

export const Event = define('event_proof', {
  schema: {
    title: Str({ required: true }),
    description: Markdown(),
    startsAt: DateTime(),
    venue: Relation('venue', { effects: { deleted: 'restrict', transitioned: { archived: 'nullify' } } }),
    organizer: Relation('user', { cascade: 'nullify' }),
    phase: Lifecycle({
      draft: ['published', 'cancelled'],
      published: ['cancelled'],
    }),
  },
  storage: Persistent(),
  description: 'Test event entity',
});

export const Note = define('note', {
  schema: {
    title: Str({ required: true }),
    body: Markdown(),
    author: Relation('user', { cascade: 'cascade' }),
  },
  storage: Persistent(),
  description: 'Test note entity',
});

export const Registration = define('registration', {
  schema: {
    event: Relation('event_proof', { cascade: 'cascade' }),
    attendee: Relation('user', { cascade: 'cascade' }),
    confirmedAt: DateTime(),
    status: Lifecycle({
      pending: ['confirmed', 'cancelled'],
      confirmed: ['cancelled'],
    }),
  },
  storage: Persistent(),
  description: 'Test registration entity',
});

// ── Participations ─────────────────────────────────────────────

const userP = participate(User, {});
const venueP = participate(Venue, {});
const eventP = participate(Event, {});
const noteP = participate(Note, {});
const registrationP = participate(Registration, {});

// ── Bundle ─────────────────────────────────────────────────────

/**
 * All proof entity declarations — pass directly to createTestHarness({ declarations }).
 */
export const proofEntities: readonly DeclarationRecord[] = [
  User, Venue, Event, Note, Registration,
  userP, venueP, eventP, noteP, registrationP,
];
