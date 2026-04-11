/**
 * Session token resolution — shared by auth routes, http-identity, and SSE handler.
 *
 * Resolves a session token (from cookie or header) to an Identity by looking up
 * the session entity in the store. Checks that the session is active and not expired.
 */

import type { DispatchRuntime } from '@janus/pipeline';
import type { EntityRecord, Identity } from '@janus/core';

/**
 * Resolve a session token to an Identity.
 * Returns null if the session is not found, inactive, or expired.
 */
export async function resolveSessionIdentity(
  runtime: DispatchRuntime,
  sessionToken: string,
): Promise<Identity | null> {
  try {
    const result = await runtime.dispatch(
      'system', 'session', 'read',
      { where: { token: sessionToken } },
    );

    if (!result.ok || !result.data) return null;

    const data = result.data as { records?: EntityRecord[] };
    if (!data.records || data.records.length === 0) return null;

    const session = data.records[0];

    // Check session is active
    if (session.status !== 'active') return null;

    // Check token expiry
    const expiresAt = session._tokenExpiresAt as string | undefined;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) return null;

    // Roles were captured from the JWT at session creation time and stored as
    // a JSON array on the session row. Fall back to ['user'] if the column is
    // empty (legacy sessions created before this field existed).
    const rawRoles = session.roles;
    const roles: readonly string[] = Array.isArray(rawRoles)
      ? (rawRoles as unknown[]).filter((r): r is string => typeof r === 'string')
      : ['user'];

    return Object.freeze({
      id: (session.identity_id as string) || (session.subject as string),
      roles: Object.freeze([...roles]),
    });
  } catch {
    return null;
  }
}
