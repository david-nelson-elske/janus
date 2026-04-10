/**
 * Membership subscriptions — auto-activate free tiers, set memberSince,
 * Keycloak role sync, confirmation email.
 */
import { subscribe, handler, Created, Transitioned, SYSTEM } from '@janus/core';
import { membership } from '../entities';
import type { ConcernContext } from '@janus/core';

// ── Handlers ──────────────────────────────────────────────────────

handler('membership-auto-activate', async (ctx: ConcernContext) => {
  const { entityId } = ctx.input as { entityId: string };
  const dispatch = ctx._dispatch!;

  // Read the created membership
  const result = await dispatch('membership', 'read', { id: entityId }, SYSTEM);
  const data = (result as { data?: Record<string, unknown> })?.data;
  if (!data) return;

  const feeCents = (data.feeCents as number) ?? 0;
  if (feeCents === 0) {
    console.log(`[membership] Free tier membership ${entityId}, auto-activating`);
    await dispatch('membership', 'update:active', { id: entityId }, SYSTEM);
  }
}, 'Auto-activate free tier memberships on create');

handler('membership-activated', async (ctx: ConcernContext) => {
  const { entityId } = ctx.input as { entityId: string };
  const dispatch = ctx._dispatch!;

  const result = await dispatch('membership', 'read', { id: entityId }, SYSTEM);
  const data = (result as { data?: Record<string, unknown> })?.data;
  if (!data) return;

  const userId = data.userId as string | undefined;
  if (userId) {
    // Set memberSince on first activation
    const userResult = await dispatch('user', 'read', { id: userId }, SYSTEM);
    const userData = (userResult as { data?: Record<string, unknown> })?.data;
    if (userData && !userData.memberSince) {
      const startsAt = data.startsAt as string | undefined;
      await dispatch('user', 'update', {
        id: userId,
        memberSince: startsAt || new Date().toISOString(),
      }, SYSTEM);
      console.log(`[membership] User ${userId} memberSince set`);
    }

    // Keycloak role sync (best-effort)
    try {
      const { syncKeycloakRole } = await import('../../adapters/keycloak');
      await syncKeycloakRole(userId, 'member', 'assign');
    } catch (err) {
      console.warn(`[membership] Keycloak role sync skipped for ${userId}:`, err);
    }
  }

  // Send welcome email (best-effort)
  try {
    const { sendEmail } = await import('../../connectors/email');
    const tier = (data.tier as string) ?? 'membership';
    await sendEmail(
      'Welcome to Your Community Association',
      `Your ${tier} membership is now active.\n\nView your membership details and QR code on the community website.`,
    );
  } catch (err) {
    console.warn(`[membership] Welcome email failed:`, err);
  }
}, 'Set memberSince, sync Keycloak role, send welcome email');

handler('membership-role-cleanup', async (ctx: ConcernContext) => {
  const { entityId } = ctx.input as { entityId: string };
  const dispatch = ctx._dispatch!;

  const result = await dispatch('membership', 'read', { id: entityId }, SYSTEM);
  const data = (result as { data?: Record<string, unknown> })?.data;
  if (!data) return;

  const userId = data.userId as string | undefined;
  if (!userId) return;

  // Check for remaining active memberships
  const activeResult = await dispatch('membership', 'read', {
    where: { userId, status: 'active' },
    limit: 1,
  }, SYSTEM);
  const remaining = ((activeResult as { data?: { records?: unknown[] } })?.data?.records ?? []).length;

  if (remaining === 0) {
    try {
      const { syncKeycloakRole } = await import('../../adapters/keycloak');
      await syncKeycloakRole(userId, 'member', 'remove');
    } catch (err) {
      console.warn(`[membership] Keycloak role removal skipped for ${userId}:`, err);
    }
  }
}, 'Remove Keycloak member role if no remaining active memberships');

// ── Subscriptions ──────────────────────────────────────────────────

export const membershipSubscriptions = subscribe(membership, [
  {
    on: Created,
    handler: 'membership-auto-activate',
    config: {},
    failure: 'log',
  },
  {
    on: Transitioned('pending', 'active'),
    handler: 'membership-activated',
    config: {},
    failure: 'log',
  },
  {
    on: Transitioned('active', 'expired'),
    handler: 'membership-role-cleanup',
    config: {},
    failure: 'log',
  },
  {
    on: Transitioned('active', 'cancelled'),
    handler: 'membership-role-cleanup',
    config: {},
    failure: 'log',
  },
]);
