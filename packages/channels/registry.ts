/**
 * Channel registry — the closed set of channels an app exposes.
 *
 * Mirrors the controller-registry pattern: the app composes a single
 * barrel mapping kebab-case channel name → declaration. The publish /
 * subscribe runtime validates against this map; the SSE bridge uses it
 * to route incoming subscribe requests.
 *
 * Per `.planning/CHANNEL-DECLARATIONS.md` §5 "The registry".
 */

import type { ChannelDeclaration } from './types';

export type ChannelRegistry = Readonly<Record<string, ChannelDeclaration>>;

/**
 * Look up a channel declaration by name.
 *
 * Throws `UnknownChannelError` when the name isn't in the registry —
 * better to fail fast than fan out an event with no shape contract.
 */
export function lookupChannel(
  registry: ChannelRegistry,
  name: string,
): ChannelDeclaration {
  const decl = registry[name];
  if (!decl) {
    throw new UnknownChannelError(name, Object.keys(registry));
  }
  return decl;
}

export class UnknownChannelError extends Error {
  override readonly name = 'UnknownChannelError';
  constructor(readonly channelName: string, readonly known: readonly string[]) {
    super(
      `Unknown channel "${channelName}". Registered: [${known.join(', ') || '<empty>'}]`,
    );
  }
}
