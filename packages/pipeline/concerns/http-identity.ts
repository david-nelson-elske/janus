/**
 * http-identity — Resolve caller identity from HTTP request.
 *
 * Order=6, non-transactional. Two resolution strategies, tried in order:
 *
 * 1. **OIDC JWT** — `Authorization: Bearer <token>` header. Validates JWT against
 *    the OIDC provider's JWKS endpoint. Maps claims to Identity (sub → id,
 *    configurable claim path → roles). Requires `config.oidc`.
 *
 * 2. **API key** — `X-API-Key` header. Looks up the key in a config-provided map.
 *    Requires `config.keys`.
 *
 * Falls back to ANONYMOUS if no credentials or validation fails.
 */

import type { ExecutionHandler, Identity, ConcernContext, EntityRecord } from '@janus/core';
import { ANONYMOUS, setIdentity } from '@janus/core';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

const SESSION_COOKIE_NAME = 'janus_session';

// ── Config types ────────────────────────────────────────────────

export interface OidcConfig {
  /** OIDC issuer URL (e.g., https://keycloak.example.com/realms/myrealm). */
  readonly issuer: string;
  /** Expected audience (client_id). */
  readonly clientId: string;
  /**
   * Dot-path to roles array in the JWT payload.
   * Default: 'realm_access.roles' (Keycloak convention).
   * Examples: 'roles', 'resource_access.myapp.roles', 'groups'.
   */
  readonly rolesClaim?: string;
  /**
   * Dot-path to scopes in the JWT payload.
   * Default: 'scope' (space-separated string, split automatically).
   */
  readonly scopesClaim?: string;
  /**
   * Map OIDC role names to framework policy group names.
   * Unmapped roles pass through unchanged.
   * Example: `{ 'board-member': 'board', 'realm-admin': 'admin' }`
   */
  readonly roleMap?: Readonly<Record<string, string>>;
}

export interface HttpIdentityConfig {
  readonly keys?: Readonly<Record<string, Identity>>;
  readonly oidc?: OidcConfig;
}

// ── JWKS cache ──────────────────────────────────────────────────

/**
 * Cache JWKS resolvers per issuer to avoid re-fetching on every request.
 * jose's createRemoteJWKSet handles key rotation internally with its own cache.
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

function getJwks(issuer: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    const jwksUrl = new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks.json`);
    jwks = createRemoteJWKSet(jwksUrl);
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

export function clearJwksCache(): void {
  jwksCache.clear();
  _oidcProviderCache = undefined;
}

// ── OIDC provider entity cache ─────────────────────────────────

/**
 * Cached OIDC config read from the oidc_provider singleton entity.
 * Read once on first request, cleared on clearJwksCache().
 */
let _oidcProviderCache: OidcConfig | null | undefined;

async function resolveOidcConfig(ctx: ConcernContext, participationConfig: HttpIdentityConfig): Promise<OidcConfig | undefined> {
  // Participation record config takes priority (backward compat / tests)
  if (participationConfig?.oidc) return participationConfig.oidc;

  // Read from oidc_provider entity (cached)
  if (_oidcProviderCache !== undefined) return _oidcProviderCache ?? undefined;

  try {
    const record = await ctx.store.read('oidc_provider', { id: '_s:oidc_provider' });
    if (record && 'id' in record && record.issuer && record.client_id) {
      _oidcProviderCache = Object.freeze({
        issuer: record.issuer as string,
        clientId: record.client_id as string,
        rolesClaim: (record.roles_claim as string) || undefined,
        scopesClaim: (record.scope_claim as string) || undefined,
        roleMap: record.role_map as Record<string, string> | undefined,
      });
      return _oidcProviderCache;
    }
  } catch {
    // oidc_provider entity may not exist (e.g., in minimal test setups)
  }

  _oidcProviderCache = null;
  return undefined;
}

// ── Claim extraction (exported so auth-routes.ts can reuse the same logic) ──

export function getNestedClaim(payload: JWTPayload, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Normalize a JWT claim value (array or space-separated string) into a string list. */
export function extractClaimList(payload: JWTPayload, claimPath: string): readonly string[] {
  const raw = getNestedClaim(payload, claimPath);
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string');
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

// ── Handler ─────────────────────────────────────────────────────

export const httpIdentity: ExecutionHandler = async (ctx) => {
  const headers = ctx.httpRequest?.headers;
  if (!headers) return;

  const config = ctx.config as unknown as HttpIdentityConfig;

  // Strategy 1: OIDC JWT via Authorization: Bearer <token>
  const oidcConfig = await resolveOidcConfig(ctx, config);
  if (oidcConfig) {
    const authHeader = headers['authorization'] ?? headers['Authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const identity = await resolveOidcIdentity(token, oidcConfig);
      if (identity) {
        setIdentity(ctx, identity);
        return;
      }
      // Invalid token → fall through to API key or ANONYMOUS
    }
  }

  // Strategy 2: Session cookie (janus_session)
  const cookieHeader = headers['cookie'];
  if (cookieHeader) {
    const sessionToken = parseCookieValue(cookieHeader, SESSION_COOKIE_NAME);
    if (sessionToken) {
      const identity = await resolveSessionCookie(ctx, sessionToken);
      if (identity) {
        setIdentity(ctx, identity);
        return;
      }
    }
  }

  // Strategy 3: API key via X-API-Key header
  // Note: header keys are normalized to lowercase by the HTTP surface (hono-app.ts)
  const apiKey = headers['x-api-key'];
  if (apiKey && config?.keys) {
    const resolved = config.keys[apiKey];
    if (resolved) {
      setIdentity(ctx, resolved);
      return;
    }
  }

  setIdentity(ctx, ANONYMOUS);
};

// ── Session cookie resolution ──────────────────────────────────

function parseCookieValue(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

async function resolveSessionCookie(ctx: ConcernContext, sessionToken: string): Promise<Identity | null> {
  try {
    const result = await ctx.store.read('session', { where: { token: sessionToken } });
    if (!result || !('records' in result)) return null;

    const records = (result as { records: EntityRecord[] }).records;
    if (records.length === 0) return null;

    const session = records[0];

    // Check session is active
    if (session.status !== 'active') return null;

    // Check token expiry
    const expiresAt = session._tokenExpiresAt as string | undefined;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return null;

    return Object.freeze({
      id: (session.identity_id as string) || (session.subject as string),
      roles: Object.freeze(['user'] as readonly string[]),
    });
  } catch {
    return null;
  }
}

// ── OIDC resolution ─────────────────────────────────────────────

async function resolveOidcIdentity(token: string, oidc: OidcConfig): Promise<Identity | null> {
  try {
    const jwks = getJwks(oidc.issuer);

    const { payload } = await jwtVerify(token, jwks, {
      issuer: oidc.issuer,
      audience: oidc.clientId,
    });

    const id = payload.sub;
    if (!id) return null;

    const rolesClaim = oidc.rolesClaim ?? 'realm_access.roles';
    const scopesClaim = oidc.scopesClaim ?? 'scope';

    const rawRoles = extractClaimList(payload, rolesClaim);
    const roles = oidc.roleMap
      ? rawRoles.map(r => oidc.roleMap![r] ?? r)
      : rawRoles;
    const scopes = extractClaimList(payload, scopesClaim);

    return Object.freeze({
      id,
      roles: roles.length > 0 ? Object.freeze([...roles]) : Object.freeze(['user']),
      ...(scopes.length > 0 ? { scopes: Object.freeze([...scopes]) } : {}),
    });
  } catch (err) {
    // Expected JWT errors (expired, bad signature, wrong claims) → silent ANONYMOUS fallback.
    // Infrastructure errors (JWKS fetch failure, network) → warn so operators can diagnose.
    const isJwtError = err instanceof joseErrors.JWTExpired
      || err instanceof joseErrors.JWTClaimValidationFailed
      || err instanceof joseErrors.JWSSignatureVerificationFailed
      || err instanceof joseErrors.JWTInvalid
      || err instanceof joseErrors.JWSInvalid;
    if (!isJwtError) {
      console.warn('[http-identity] OIDC verification failed (infrastructure):', err instanceof Error ? err.message : err);
    }
    return null;
  }
}
