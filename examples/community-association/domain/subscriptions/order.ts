/**
 * Order subscriptions — fulfill orders (create memberships/registrations),
 * send confirmation email, handle failures.
 */
import { subscribe, handler, Transitioned, SYSTEM } from '@janus/core';
import { order } from '../entities';
import type { ConcernContext } from '@janus/core';
import { config } from '../../config';

handler('order-fulfill', async (ctx: ConcernContext) => {
  const { entityId } = ctx.input as { entityId: string };
  const dispatch = ctx._dispatch!;

  const result = await dispatch('order', 'read', { id: entityId }, SYSTEM);
  const data = (result as { data?: Record<string, unknown> })?.data;
  if (!data) return;

  const totalCents = (data.totalCents as number) || 0;
  const lineItemsRaw = data.lineItems as string;
  let lineItems: Array<{
    type: string; name: string; unitAmount: number;
    gstCents: number; serviceFeeCents: number; quantity: number;
    metadata: Record<string, string>;
  }>;
  try {
    lineItems = JSON.parse(lineItemsRaw);
  } catch {
    console.error(`[order] ${entityId}: failed to parse lineItems JSON`);
    return;
  }

  console.log(`[order] Fulfilling ${entityId}: ${lineItems.length} line items`);
  const confirmations: Array<{ type: string; name: string; ticketCode?: string }> = [];

  for (const item of lineItems) {
    if (item.type === 'membership') {
      const meta = item.metadata;
      const membershipResult = await dispatch('membership', 'create', {
        tier: meta.tier,
        feeCents: parseInt(meta.feeCents),
        startsAt: meta.startsAt,
        expiresAt: meta.expiresAt,
        membershipCode: meta.membershipCode || crypto.randomUUID().slice(0, 8).toUpperCase(),
        autoRenew: meta.autoRenew === 'true',
        userId: meta.userId || null,
      }, SYSTEM);
      const membershipData = (membershipResult as { data?: { id: string } })?.data;
      if (membershipData?.id && parseInt(meta.feeCents) > 0) {
        await dispatch('membership', 'update:active', { id: membershipData.id }, SYSTEM);
        console.log(`[order] Membership ${membershipData.id} (${meta.tier}) created and activated`);
      }
      confirmations.push({ type: 'membership', name: item.name });
    } else if (item.type === 'registration') {
      const meta = item.metadata;
      const regParams: Record<string, unknown> = {
        registeredAt: new Date().toISOString(),
        priceCents: parseInt(meta.basePriceCents),
        serviceFeeCents: parseInt(meta.serviceFeeCents),
        gstCents: parseInt(meta.gstCents),
        seriesId: meta.seriesId,
      };
      if (meta.sessionId) regParams.sessionId = meta.sessionId;
      const regResult = await dispatch('registration', 'create', regParams, SYSTEM);
      const regData = (regResult as { data?: Record<string, unknown> })?.data;
      if (regData?.id) {
        await dispatch('registration', 'update:confirmed', { id: regData.id }, SYSTEM);
        console.log(`[order] Registration ${regData.id} for ${meta.seriesTitle} confirmed`);
      }
      // Read back to get auto-generated ticketCode
      let ticketCode: string | undefined;
      if (regData?.id) {
        try {
          const readResult = await dispatch('registration', 'read', { id: regData.id }, SYSTEM);
          ticketCode = (readResult as { data?: Record<string, unknown> })?.data?.ticketCode as string;
        } catch { /* non-critical */ }
      }
      confirmations.push({ type: 'registration', name: item.name, ticketCode });
    } else if (item.type === 'donation') {
      const meta = item.metadata;
      const amountCents = parseInt(meta.amountCents);
      console.log(`[order] Donation of $${(amountCents / 100).toFixed(2)} CAD for order ${entityId}`);
      confirmations.push({ type: 'donation', name: `Donation — $${(amountCents / 100).toFixed(2)} CAD` });
    }
  }

  // Send confirmation email
  try {
    const { sendConfirmationEmail } = await import('../../connectors/email');
    await sendConfirmationEmail(entityId, totalCents, confirmations, config.baseUrl);
  } catch (err) {
    console.error(`[order] Confirmation email failed for ${entityId}:`, err);
  }
}, 'Fulfill order: create memberships/registrations from line items');

handler('order-failed', async (ctx: ConcernContext) => {
  const { entityId } = ctx.input as { entityId: string };
  console.warn(`[order] Order ${entityId} failed`);

  try {
    const { sendEmail } = await import('../../connectors/email');
    await sendEmail(
      'Order could not be processed',
      `We were unable to process your recent order (${entityId}).\n\nNo payment has been collected. Please try again or contact us if the problem persists.`,
    );
  } catch (err) {
    console.error(`[order] Failure notification email failed:`, err);
  }
}, 'Handle failed order — notify customer');

// ── Subscriptions ──────────────────────────────────────────────────

export const orderSubscriptions = subscribe(order, [
  {
    on: Transitioned('pending', 'fulfilled'),
    handler: 'order-fulfill',
    config: {},
    failure: 'retry',
    retry: { max: 5, backoff: 'exponential', initialDelay: 1000 },
  },
  {
    on: Transitioned('pending', 'failed'),
    handler: 'order-failed',
    config: {},
    failure: 'log',
  },
]);
