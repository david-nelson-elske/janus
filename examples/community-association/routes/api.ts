/**
 * API routes — capacity, order lookup, membership tiers, activity.
 */
import { Hono } from 'hono';
import type { App } from '@janus/http';
import { SYSTEM } from '@janus/core';
import { resolveIdentity } from './auth';

export function createApiRoutes(app: App) {
  const routes = new Hono();

  // Public: session capacity per series
  routes.get('/api/capacity/:seriesId', async (c) => {
    const seriesId = c.req.param('seriesId');
    const result = await app.dispatch('registration', 'read', {
      where: { seriesId, status: 'confirmed' },
      limit: 0,
    }, SYSTEM);
    // TODO: return count per session once store.count() is wired
    return c.json({ seriesId, registrations: 0 });
  });

  // Public: order lookup (bearer = orderId)
  routes.get('/api/order/:id', async (c) => {
    const orderId = c.req.param('id');
    const result = await app.dispatch('order', 'read', { id: orderId }, SYSTEM);
    const data = (result as { data?: Record<string, unknown> })?.data;
    if (!data) return c.json({ error: 'Order not found' }, 404);
    return c.json(data);
  });

  // Public: membership tiers
  routes.get('/api/membership-tiers', async (c) => {
    const result = await app.dispatch('membership_tier', 'read', {
      where: { status: 'active' },
      sort: [{ field: 'sortOrder', direction: 'asc' }],
    }, SYSTEM);
    const data = (result as { data?: { records?: unknown[] } })?.data;
    return c.json(data?.records ?? []);
  });

  // Member: my activity (orders + upcoming sessions)
  routes.get('/api/my-activity', async (c) => {
    const identity = resolveIdentity(c.req.raw);
    if (identity.id === 'anonymous') {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    const [ordersResult, regsResult] = await Promise.all([
      app.dispatch('order', 'read', {
        where: { createdBy: identity.id },
        sort: [{ field: 'createdAt', direction: 'desc' }],
        limit: 20,
      }, SYSTEM),
      app.dispatch('registration', 'read', {
        where: { createdBy: identity.id, status: 'confirmed' },
        limit: 50,
      }, SYSTEM),
    ]);

    return c.json({
      orders: (ordersResult as { data?: { records?: unknown[] } })?.data?.records ?? [],
      registrations: (regsResult as { data?: { records?: unknown[] } })?.data?.records ?? [],
    });
  });

  return routes;
}
