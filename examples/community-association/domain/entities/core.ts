/**
 * Core entities: user, facility, series, session, registration, membership, membership_tier
 */
import { define } from '@janus/core';
import {
  Str, Int, IntCents, Email, DateTime, Bool, Asset, Markdown,
  LatLng, QrCode, Recurrence, Availability,
  Public, Private, Persistent, Relation,
} from '@janus/vocabulary';
import {
  userLifecycle, facilityLifecycle, seriesLifecycle, sessionLifecycle,
  registrationLifecycle, membershipLifecycle, membershipTierLifecycle,
} from '../lifecycles';

// ── User ──────────────────────────────────────────────────────────
export const user = define('user', {
  schema: Private({
    email: Email({ required: true }),
    displayName: Str({ required: true, as: 'title' }),
    role: Str({ as: 'subtitle' }),
    bio: Markdown({ as: 'body' }),
    photo: Asset({ accept: 'image/*', as: 'image' }),
    memberSince: DateTime({ as: 'timestamp' }),
    status: userLifecycle,
  }),
  storage: Persistent(),
  description: 'Community association member',
});

// ── Facility ──────────────────────────────────────────────────────
export const facility = define('facility', {
  schema: Public({
    name: Str({ required: true, as: 'title' }),
    description: Markdown({ as: 'body' }),
    location: LatLng(),
    capacity: Int(),
    image: Asset({ accept: 'image/*', as: 'image' }),
    photos: Asset({ accept: 'image/*' }),
    availability: Availability(),
    status: facilityLifecycle,
  }),
  storage: Persistent(),
  description: 'Bookable community facility',
});

// ── Series (events/programs) ──────────────────────────────────────
export const series = define('series', {
  schema: Public({
    title: Str({ required: true, as: 'title' }),
    description: Markdown({ as: 'body' }),
    type: Str({ as: 'subtitle' }),
    capacity: Int(),
    priceCents: IntCents({ as: 'amount' }),
    memberPriceCents: IntCents(),
    sessionMode: Str(),
    image: Asset({ accept: 'image/*', as: 'image' }),
    photos: Asset({ accept: 'image/*' }),
    publishedAt: DateTime({ as: 'timestamp' }),
    defaultFacilityId: Relation('facility'),
    pattern: Recurrence('session'),
    status: seriesLifecycle,
  }),
  storage: Persistent(),
  description: 'Event series or recurring program',
});

// ── Session (individual occurrence) ───────────────────────────────
export const session = define('session', {
  schema: Public({
    startsAt: DateTime({ required: true, as: 'timestamp' }),
    endsAt: DateTime({ required: true }),
    notes: Str(),
    priceCents: IntCents(),
    seriesId: Relation('series', {
      cascade: 'cascade',
      effects: { transitioned: { cancelled: 'cascade' } },
    }),
    facilityId: Relation('facility'),
    status: sessionLifecycle,
  }),
  storage: Persistent(),
  description: 'Single session within a series',
});

// ── Registration ──────────────────────────────────────────────────
export const registration = define('registration', {
  schema: Private({
    registeredAt: DateTime({ required: true, as: 'timestamp' }),
    priceCents: IntCents({ required: true, as: 'amount' }),
    serviceFeeCents: IntCents({ required: true }),
    gstCents: IntCents({ required: true }),
    seriesId: Relation('series', {
      cascade: 'cascade',
      effects: { transitioned: { cancelled: 'cascade' } },
    }),
    sessionId: Relation('session'),
    ticketCode: QrCode({ singleUse: false }),
    status: registrationLifecycle,
  }),
  storage: Persistent(),
  description: 'Event registration linking a user to a series',
  owned: true,
});

// ── Membership ────────────────────────────────────────────────────
export const membership = define('membership', {
  schema: Private({
    tier: Str({ required: true, as: 'title' }),
    feeCents: IntCents({ required: true, as: 'amount' }),
    startsAt: DateTime({ required: true, as: 'timestamp' }),
    expiresAt: DateTime({ required: true }),
    membershipCode: Str({ required: true }),
    userId: Str(),
    autoRenew: Bool(),
    stripeCustomerId: Str({ searchable: false }),
    stripeSubscriptionId: Str({ searchable: false }),
    memberQr: QrCode({ singleUse: false, expiresWith: 'expiresAt' }),
    status: membershipLifecycle,
  }),
  storage: Persistent(),
  description: 'Association membership record',
  owned: true,
});

// ── Membership Tier ───────────────────────────────────────────────
export const membership_tier = define('membership_tier', {
  schema: Public({
    key: Str({ required: true }),
    label: Str({ required: true, as: 'title' }),
    priceCents: IntCents({ required: true, as: 'amount' }),
    description: Str({ as: 'subtitle' }),
    sortOrder: Int(),
    purchasable: Bool(),
    status: membershipTierLifecycle,
  }),
  storage: Persistent(),
  description: 'Membership pricing tier',
});
