/**
 * Stripe webhook — handles payment completion events.
 */
import { Hono } from 'hono';
import type { App } from '@janus/http';
import { SYSTEM } from '@janus/core';
import { config } from '../config';

export function createStripeWebhookRoutes(app: App) {
  const routes = new Hono();

  routes.post('/stripe/webhook', async (c) => {
    if (!config.stripe) {
      return c.json({ error: 'Stripe not configured' }, 500);
    }

    const body = await c.req.text();
    const signature = c.req.header('stripe-signature');

    if (!signature) {
      return c.json({ error: 'Missing signature' }, 400);
    }

    try {
      const Stripe = (await import('stripe')).default;
      const stripe = new Stripe(config.stripe.secretKey);
      const event = stripe.webhooks.constructEvent(body, signature, config.stripe.webhookSecret);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as { id: string; metadata?: { orderId?: string } };
        const orderId = session.metadata?.orderId;

        if (orderId) {
          // Create payment record
          await app.dispatch('payment', 'create', {
            orderId,
            amountCents: 0, // TODO: extract from session
            currency: config.locale.currency,
            providerSessionId: session.id,
          }, SYSTEM);

          // Fulfill the order (triggers subscription handlers)
          await app.dispatch('order', 'update:fulfilled', { id: orderId }, SYSTEM);
          console.log(`[stripe] Order ${orderId} fulfilled`);
        }
      }

      return c.json({ received: true });
    } catch (err) {
      console.error('[stripe] Webhook error:', err);
      return c.json({ error: 'Webhook verification failed' }, 400);
    }
  });

  return routes;
}
