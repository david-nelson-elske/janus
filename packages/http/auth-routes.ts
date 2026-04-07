/**
 * Auth route derivation — login/callback/logout/me.
 *
 * Derived automatically from the oidc_provider entity configuration.
 * When issuer is configured, mounts:
 *   GET  {basePath}/auth/login    — redirect to OIDC authorize endpoint (PKCE)
 *   GET  {basePath}/auth/callback — exchange code for tokens, create session, set cookie
 *   POST {basePath}/auth/logout   — revoke session, clear cookie, redirect to OIDC logout
 *   GET  {basePath}/auth/me       — return current identity from session or JWT
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DispatchRuntime, ConnectionManager } from '@janus/pipeline';
import type { EntityRecord, Identity } from '@janus/core';
import { ANONYMOUS, isReadPage } from '@janus/core';
import { decodeJwt } from 'jose';
import { resolveSessionIdentity } from './session-resolve';

// ── OIDC discovery cache ───────────────────────────────────────

export interface OidcEndpoints {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly end_session_endpoint?: string;
  readonly userinfo_endpoint?: string;
}

const discoveryCache = new Map<string, OidcEndpoints>();

export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

async function discoverEndpoints(issuer: string): Promise<OidcEndpoints> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;

  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
  }

  const config = await res.json() as Record<string, unknown>;
  const endpoints: OidcEndpoints = {
    authorization_endpoint: config.authorization_endpoint as string,
    token_endpoint: config.token_endpoint as string,
    end_session_endpoint: config.end_session_endpoint as string | undefined,
    userinfo_endpoint: config.userinfo_endpoint as string | undefined,
  };

  discoveryCache.set(issuer, endpoints);
  return endpoints;
}

// ── PKCE helpers ───────────────────────────────────────────────

function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── PKCE state store (in-memory, per-process) ──────────────────

const pendingAuths = new Map<string, { verifier: string; redirectUri: string; createdAt: number }>();

// Clean up expired entries (older than 10 minutes)
function cleanPendingAuths(): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, value] of pendingAuths) {
    if (value.createdAt < cutoff) pendingAuths.delete(key);
  }
}

// ── Route config ───────────────────────────────────────────────

export interface OidcProviderRecord {
  readonly issuer: string;
  readonly client_id: string;
  readonly client_secret: string;
  readonly roles_claim?: string;
  readonly scope_claim?: string;
  readonly role_map?: Record<string, string>;
  readonly identity_entity?: string;
  readonly subject_field?: string;
}

export interface AuthRoutesConfig {
  readonly oidcProvider: OidcProviderRecord;
  readonly runtime: DispatchRuntime;
  readonly basePath: string;
  readonly appBaseUrl?: string;
}

export const SESSION_COOKIE = 'janus_session';

// ── Route creation ─────────────────────────────────────────────

export function createAuthRoutes(config: AuthRoutesConfig): Hono {
  const routes = new Hono();
  const { oidcProvider, runtime, basePath } = config;

  // GET /auth/login — redirect to OIDC provider
  routes.get(`${basePath}/auth/login`, async (c) => {
    try {
      const endpoints = await discoverEndpoints(oidcProvider.issuer);
      const state = crypto.randomUUID();
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      const redirectUri = new URL(`${basePath}/auth/callback`, c.req.url).toString();
      pendingAuths.set(state, { verifier, redirectUri, createdAt: Date.now() });
      cleanPendingAuths();

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: oidcProvider.client_id,
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });

      return c.redirect(`${endpoints.authorization_endpoint}?${params.toString()}`);
    } catch (err) {
      console.error('[auth] OIDC login failed:', err);
      return c.json({ ok: false, error: { kind: 'auth-error', message: 'OIDC login failed' } }, 500);
    }
  });

  // GET /auth/callback — exchange code for tokens
  routes.get(`${basePath}/auth/callback`, async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      const desc = c.req.query('error_description') ?? error;
      return c.json({ ok: false, error: { kind: 'auth-error', message: desc } }, 400);
    }

    if (!code || !state) {
      return c.json({ ok: false, error: { kind: 'parse-error', message: 'Missing code or state parameter' } }, 400);
    }

    const pending = pendingAuths.get(state);
    if (!pending) {
      return c.json({ ok: false, error: { kind: 'auth-error', message: 'Invalid or expired state parameter' } }, 400);
    }
    pendingAuths.delete(state);

    try {
      const endpoints = await discoverEndpoints(oidcProvider.issuer);

      // Exchange authorization code for tokens
      const tokenRes = await fetch(endpoints.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: pending.redirectUri,
          client_id: oidcProvider.client_id,
          ...(oidcProvider.client_secret ? { client_secret: oidcProvider.client_secret } : {}),
          code_verifier: pending.verifier,
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        console.error('[auth] Token exchange failed:', body);
        return c.json({ ok: false, error: { kind: 'auth-error', message: 'Token exchange failed' } }, 400);
      }

      const tokens = await tokenRes.json() as { id_token?: string; access_token: string; refresh_token?: string };

      // Decode the ID token to get the subject.
      // Uses jose.decodeJwt for structured parsing and basic claims validation.
      // Full signature verification deferred — token was just received over TLS from the provider's token endpoint.
      let idPayload: { sub: string; [k: string]: unknown };
      if (tokens.id_token) {
        try {
          const claims = decodeJwt(tokens.id_token);
          if (!claims.sub) throw new Error('ID token missing sub claim');
          idPayload = claims as { sub: string; [k: string]: unknown };
        } catch (err) {
          console.error('[auth] Failed to decode ID token:', err);
          return c.json({ ok: false, error: { kind: 'auth-error', message: 'Invalid ID token' } }, 400);
        }
      } else {
        idPayload = { sub: 'unknown' };
      }

      // Create session entity
      const sessionResult = await runtime.dispatch(
        'system', 'session', 'create',
        {
          subject: idPayload.sub,
          refresh_token: tokens.refresh_token ?? '',
          provider: oidcProvider.issuer,
        },
      );

      if (!sessionResult.ok) {
        return c.json({ ok: false, error: sessionResult.error }, 500);
      }

      const sessionRecord = sessionResult.data as EntityRecord;

      // Set session cookie
      const isSecure = c.req.url.startsWith('https');
      setCookie(c, SESSION_COOKIE, sessionRecord.token as string, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'Lax',
        path: '/',
        maxAge: 24 * 60 * 60, // 24 hours (matches token expiry)
      });

      // Redirect to app root (or configured URL)
      const redirectTo = config.appBaseUrl ?? '/';
      return c.redirect(redirectTo);
    } catch (err) {
      console.error('[auth] Callback failed:', err);
      return c.json({ ok: false, error: { kind: 'auth-error', message: 'Authentication callback failed' } }, 500);
    }
  });

  // POST /auth/logout — revoke session, clear cookie
  routes.post(`${basePath}/auth/logout`, async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);

    if (sessionToken) {
      // Find and revoke the session
      const identity = await resolveSessionIdentity(runtime, sessionToken);
      if (identity) {
        // Look up the session by token to get its ID for transition
        const sessions = await runtime.dispatch('system', 'session', 'read', { where: { token: sessionToken } });
        if (sessions.ok && sessions.data) {
          const data = sessions.data as { records?: EntityRecord[] };
          if (data.records && data.records.length > 0) {
            await runtime.dispatch('system', 'session', 'revoked', { id: data.records[0].id });
          }
        }
      }
    }

    deleteCookie(c, SESSION_COOKIE, { path: '/' });

    // Redirect to OIDC end_session_endpoint if available
    try {
      const endpoints = await discoverEndpoints(oidcProvider.issuer);
      if (endpoints.end_session_endpoint) {
        const params = new URLSearchParams({
          client_id: oidcProvider.client_id,
          post_logout_redirect_uri: config.appBaseUrl ?? new URL('/', c.req.url).toString(),
        });
        return c.redirect(`${endpoints.end_session_endpoint}?${params.toString()}`);
      }
    } catch {
      // If discovery fails, just redirect locally
    }

    return c.redirect(config.appBaseUrl ?? '/');
  });

  // GET /auth/me — return current identity
  routes.get(`${basePath}/auth/me`, async (c) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);

    if (sessionToken) {
      const identity = await resolveSessionIdentity(runtime, sessionToken);
      if (identity) {
        return c.json({ ok: true, data: identity });
      }
    }

    return c.json({ ok: true, data: { id: 'anonymous', roles: ['anonymous'] } });
  });

  return routes;
}
