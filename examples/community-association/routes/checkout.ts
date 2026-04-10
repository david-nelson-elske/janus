/**
 * Checkout routes — cart checkout flow with Stripe integration.
 */
import { Hono } from 'hono';
import type { App } from '@janus/http';
import { SYSTEM } from '@janus/core';
import { config } from '../config';
import { resolveIdentity } from './auth';

interface CartItem {
  type: 'membership' | 'registration' | 'donation';
  name: string;
  unitAmount: number;
  gstCents: number;
  serviceFeeCents: number;
  quantity: number;
  metadata: Record<string, string>;
}

export function createCheckoutRoutes(app: App) {
  const routes = new Hono();

  routes.post('/api/checkout', async (c) => {
    const body = await c.req.json<{ items: CartItem[]; email: string }>();
    const identity = resolveIdentity(c.req.raw);

    if (!body.items || body.items.length === 0) {
      return c.json({ error: 'Cart is empty' }, 400);
    }

    const totalCents = body.items.reduce(
      (sum, item) => sum + (item.unitAmount + item.gstCents + item.serviceFeeCents) * item.quantity,
      0,
    );

    // Create order record
    const orderResult = await app.dispatch('order', 'create', {
      email: body.email,
      lineItems: JSON.stringify(body.items),
      totalCents,
      currency: config.locale.currency,
    }, SYSTEM);

    const orderData = (orderResult as { data?: Record<string, unknown> })?.data;
    if (!orderData?.id) {
      return c.json({ error: 'Failed to create order' }, 500);
    }

    const orderId = orderData.id as string;

    // Free orders — fulfill immediately
    if (totalCents === 0) {
      await app.dispatch('order', 'update:fulfilled', { id: orderId }, SYSTEM);
      return c.json({ orderId, free: true });
    }

    // Paid orders — create Stripe session
    if (!config.stripe) {
      return c.json({ error: 'Payment not configured' }, 500);
    }

    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(config.stripe.secretKey);

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: body.email,
        line_items: body.items.map(item => ({
          price_data: {
            currency: config.locale.currency.toLowerCase(),
            product_data: { name: item.name },
            unit_amount: item.unitAmount + item.gstCents + item.serviceFeeCents,
          },
          quantity: item.quantity,
        })),
        success_url: `${config.stripe.successUrl}?orderId=${orderId}`,
        cancel_url: config.stripe.cancelUrl,
        metadata: { orderId },
      });

      // Update order with Stripe session info
      await app.dispatch('order', 'update', {
        id: orderId,
        providerSessionId: session.id,
        checkoutUrl: session.url,
      }, SYSTEM);

      return c.json({ orderId, checkoutUrl: session.url });
    } catch (err) {
      console.error('[checkout] Stripe session creation failed:', err);
      await app.dispatch('order', 'update:failed', { id: orderId }, SYSTEM);
      return c.json({ error: 'Payment session creation failed' }, 500);
    }
  });

  return routes;
}
