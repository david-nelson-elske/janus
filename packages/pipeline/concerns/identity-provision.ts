/**
 * identity-provision — Lookup/create local identity record from OIDC subject.
 *
 * Order=7, non-transactional. Runs after http-identity (6) and before
 * policy-lookup (10). When configured with an identity entity and subject field:
 *
 * 1. Reads the store for a local record matching the OIDC subject
 * 2. If found, rewrites ctx.identity.id to the local record's ID
 * 3. If not found, creates a new record via internal dispatch (full pipeline treatment)
 *
 * Skips for anonymous, system, and non-HTTP requests.
 */

import type { ExecutionHandler, EntityRecord, ConcernContext } from '@janus/core';
import { isReadPage, setIdentity, SYSTEM } from '@janus/core';

// ── Config type ────────────────────────────────────────────────

export interface IdentityProvisionConfig {
  /** Name of the consumer entity that represents local identities (e.g., 'member', 'user'). */
  readonly identityEntity: string;
  /** Field on the identity entity that stores the OIDC subject claim. */
  readonly subjectField: string;
}

// ── Cached config from oidc_provider entity ────────────────────

let _provisionCache: IdentityProvisionConfig | null | undefined;

export function clearProvisionCache(): void {
  _provisionCache = undefined;
}

async function resolveProvisionConfig(ctx: ConcernContext): Promise<IdentityProvisionConfig | undefined> {
  // Participation record config takes priority (explicit wiring / tests)
  const participationConfig = ctx.config as unknown as IdentityProvisionConfig;
  if (participationConfig?.identityEntity && participationConfig?.subjectField) {
    return participationConfig;
  }

  // Read from oidc_provider entity (cached)
  if (_provisionCache !== undefined) return _provisionCache ?? undefined;

  try {
    const record = await ctx.store.read('oidc_provider', { id: '_s:oidc_provider' });
    if (record && 'id' in record && record.identity_entity && record.subject_field) {
      _provisionCache = Object.freeze({
        identityEntity: record.identity_entity as string,
        subjectField: record.subject_field as string,
      });
      return _provisionCache;
    }
  } catch {
    // oidc_provider entity may not exist in minimal test setups
  }

  _provisionCache = null;
  return undefined;
}

// ── Handler ─────────────────────────────────────────────────────

export const identityProvision: ExecutionHandler = async (ctx) => {
  // Only for HTTP requests with authenticated identity
  if (!ctx.httpRequest) return;
  if (ctx.identity.id === 'anonymous' || ctx.identity.id === 'system') return;

  const config = await resolveProvisionConfig(ctx);
  if (!config) return;

  // Fast path: direct store read for existing identity
  const existing = await ctx.store.read(config.identityEntity, {
    where: { [config.subjectField]: ctx.identity.id },
  });

  if (isReadPage(existing) && existing.records.length > 0) {
    setIdentity(ctx, Object.freeze({
      id: existing.records[0].id,
      roles: ctx.identity.roles,
      scopes: ctx.identity.scopes,
    }));
    return;
  }

  // Auto-provision via internal dispatch (full pipeline treatment)
  if (!ctx._dispatch) return;

  const result = await ctx._dispatch(
    config.identityEntity,
    'create',
    { [config.subjectField]: ctx.identity.id },
    SYSTEM,
  );

  if (result.ok && result.data) {
    setIdentity(ctx, Object.freeze({
      id: (result.data as EntityRecord).id,
      roles: ctx.identity.roles,
      scopes: ctx.identity.scopes,
    }));
  }
};
