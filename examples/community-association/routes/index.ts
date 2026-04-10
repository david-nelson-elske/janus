/**
 * Mount all custom routes onto a Hono app.
 */
import { Hono } from 'hono';
import type { App } from '@janus/http';
import { createAuthRoutes } from './auth';
import { createCheckoutRoutes } from './checkout';
import { createStripeWebhookRoutes } from './stripe-webhook';
import { createApiRoutes } from './api';

export function mountRoutes(app: App): Hono {
  const hono = new Hono();

  // Custom routes (higher priority)
  hono.route('/', createAuthRoutes(app));
  hono.route('/', createCheckoutRoutes(app));
  hono.route('/', createStripeWebhookRoutes(app));
  hono.route('/', createApiRoutes(app));

  // Framework routes (catchall)
  hono.all('*', async (c) => {
    return app.fetch(c.req.raw);
  });

  return hono;
}
