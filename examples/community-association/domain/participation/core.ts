/**
 * Participation for core entities: user, facility, series, session,
 * registration, membership, membership_tier
 */
import { participate } from '@janus/core';
import { AuditFull } from '@janus/vocabulary';
import type { ConcernContext } from '@janus/core';
import {
  user, facility, series, session,
  registration, membership, membership_tier,
} from '../entities';

export const userParticipation = participate(user, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'member', operations: ['read'], ownershipField: 'createdBy' },
    ],
  },
  audit: AuditFull,
});

export const facilityParticipation = participate(facility, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const seriesParticipation = participate(series, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
  actions: {
    rsvp: {
      kind: 'mutation',
      description: 'RSVP to a free event (creates a confirmed registration at $0)',
      handler: async (ctx: ConcernContext) => {
        const entity = ctx.result as Record<string, unknown>;
        if ((entity.priceCents as number) > 0) {
          throw new Error('Cannot RSVP to a paid event — use the checkout flow.');
        }
        await ctx._dispatch!('registration', 'create', {
          seriesId: entity.id as string,
          registeredAt: new Date().toISOString(),
          priceCents: 0,
          serviceFeeCents: 0,
          gstCents: 0,
        }, ctx.identity);
      },
    },
  },
});

export const sessionParticipation = participate(session, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});

export const registrationParticipation = participate(registration, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'member', operations: ['read', 'create'] },
      { role: 'member', operations: ['update', 'delete'], ownershipField: 'createdBy' },
    ],
  },
  audit: AuditFull,
});

export const membershipParticipation = participate(membership, {
  policy: {
    rules: [
      { role: 'admin', operations: '*' },
      { role: 'system', operations: ['create', 'update'] },
      { role: 'member', operations: ['read'], ownershipField: 'createdBy' },
    ],
  },
  audit: AuditFull,
});

export const membershipTierParticipation = participate(membership_tier, {
  policy: {
    rules: [{ role: 'admin', operations: '*' }],
    anonymousRead: true,
  },
  audit: AuditFull,
});
