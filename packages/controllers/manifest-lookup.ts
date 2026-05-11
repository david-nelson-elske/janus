/**
 * Client-side manifest lookup — exposes the parsed page manifest to
 * the `JanusController` base class so it can resolve a
 * `subscribe(channel, handler)` call to the SSR-declared scope.
 *
 * The bootstrap installs the manifest via {@link installManifestLookup};
 * thereafter {@link findControllerSubscriptions} can be called from
 * any controller during its `janusConnect()`.
 */

import type { PageManifest } from './manifest';

let manifest: PageManifest | null = null;

export function installManifestLookup(m: PageManifest): void {
  manifest = m;
}

/**
 * Resolve every (scope) for which `controllerName` declared a
 * subscription to `channel` in the page manifest. A controller may
 * declare more than one subscription to the same channel (different
 * scopes); we return all of them so the base class can register one
 * SSE handler per scope.
 */
export function findControllerSubscriptions(
  controllerName: string,
  channel: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (!manifest) return [];
  const result: Readonly<Record<string, unknown>>[] = [];
  for (const c of manifest.controllers) {
    if (c.name !== controllerName) continue;
    for (const sub of c.subscriptions) {
      if (sub.channel === channel) result.push(sub.scope);
    }
  }
  return result;
}

/**
 * Resolve every (channel, scope) pair declared anywhere in the
 * manifest. The bootstrap passes this list to the channel SSE client
 * so the page opens one stream with the union of all subscriptions.
 */
export function collectAllSubscriptions(): readonly {
  channel: string;
  scope: Readonly<Record<string, unknown>>;
}[] {
  if (!manifest) return [];
  const seen = new Set<string>();
  const result: { channel: string; scope: Readonly<Record<string, unknown>> }[] = [];
  for (const c of manifest.controllers) {
    for (const sub of c.subscriptions) {
      const key = `${sub.channel}::${JSON.stringify(sub.scope)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ channel: sub.channel, scope: sub.scope });
    }
  }
  return result;
}
