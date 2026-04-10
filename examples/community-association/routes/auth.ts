/**
 * Auth routes — identity resolution, auth config endpoint.
 */
import { Hono } from 'hono';
import type { App } from '@janus/http';
import { config } from '../config';

/** Dev identity map — maps bearer tokens to identities. */
const DEV_IDENTITIES: Record<string, { id: string; displayName: string; email: string; roles: string[] }> = {
  admin: { id: 'admin', displayName: 'Admin User', email: 'admin@example.com', roles: ['admin'] },
  system: { id: 'system', displayName: 'System', email: '', roles: ['system'] },
  member: { id: 'member', displayName: 'Test Member', email: 'member@example.com', roles: ['member'] },
  user: { id: 'user', displayName: 'New User', email: 'newuser@example.com', roles: [] },
};

export function createAuthRoutes(_app: App) {
  const routes = new Hono();

  routes.get('/auth/config', (c) => {
    return c.json({ mode: config.auth.mode });
  });

  routes.get('/auth/me', (c) => {
    if (config.auth.mode === 'dev') {
      const token = c.req.header('Authorization')?.replace('Bearer ', '') ?? '';
      const identity = DEV_IDENTITIES[token];
      if (identity) return c.json(identity);
      return c.json({ id: 'anonymous', displayName: 'Anonymous', email: '', roles: [] });
    }

    // Keycloak mode — JWT already resolved by middleware
    // TODO: extract from JWT claims
    return c.json({ id: 'anonymous', displayName: 'Anonymous', email: '', roles: [] });
  });

  return routes;
}

/**
 * Resolve identity from request for dispatch calls.
 */
export function resolveIdentity(req: Request): { id: string; roles: string[] } {
  if (config.auth.mode === 'dev') {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    const identity = DEV_IDENTITIES[token];
    if (identity) return { id: identity.id, roles: identity.roles };
  }
  return { id: 'anonymous', roles: [] };
}
