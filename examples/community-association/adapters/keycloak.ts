/**
 * Keycloak admin adapter — manages realm role assignments.
 *
 * Only active when auth.mode === 'keycloak' in config.
 */
import { config } from '../config';

/**
 * Assign or remove a realm role for a user in Keycloak.
 */
export async function syncKeycloakRole(
  userId: string,
  role: string,
  action: 'assign' | 'remove',
): Promise<void> {
  if (config.auth.mode !== 'keycloak' || !config.auth.keycloak?.adminUrl) {
    console.log(`[keycloak] Skipping role ${action} (not in keycloak mode)`);
    return;
  }

  const adminUrl = config.auth.keycloak.adminUrl;
  // TODO: Implement Keycloak admin API calls
  // POST/DELETE {adminUrl}/users/{userId}/role-mappings/realm
  console.log(`[keycloak] ${action} role '${role}' for user ${userId} via ${adminUrl}`);
}
