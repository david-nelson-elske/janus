/**
 * Sensitivity — data handling label for entities.
 *
 * Three framework-defined levels that determine mount eligibility:
 *   open       → public + internal + system mounts
 *   standard   → internal + system mounts (default)
 *   restricted → system mount only
 */

export type Sensitivity = 'open' | 'standard' | 'restricted';

/** Mount trust levels (matches mount entity trust enum). */
export type MountTrust = 'public' | 'internal' | 'system';

const SENSITIVITY_CEILING: Record<Sensitivity, number> = {
  open: 0,
  standard: 1,
  restricted: 2,
};

const MOUNT_TRUST_LEVEL: Record<MountTrust, number> = {
  public: 0,
  internal: 1,
  system: 2,
};

/**
 * Check if a sensitivity level allows mounting at a given trust level.
 * Returns true if the entity can appear on the mount.
 */
export function sensitivityAllowsMount(sensitivity: Sensitivity, mountTrust: MountTrust): boolean {
  return MOUNT_TRUST_LEVEL[mountTrust] >= SENSITIVITY_CEILING[sensitivity];
}
