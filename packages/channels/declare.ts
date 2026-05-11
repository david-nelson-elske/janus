/**
 * Channel declaration — pure-data, compile-time fact about a server
 * channel: its name, payload shape, scope keys, persistence policy,
 * declared publishers/subscribers, and a human description.
 *
 * Declarations are imported by the registry, the publish/subscribe
 * runtime, the SSE bridge, the page manifest emitter, and (eventually
 * at M5) the capability graph. They contain no runtime code and are
 * safe to serialize.
 *
 * Per `.planning/CHANNEL-DECLARATIONS.md` §5 of Perspicuity.
 */
import type {
  ActorRole,
  ChannelDeclaration,
  ChannelTypeDecl,
  PersistencePolicy,
} from './types';

export type {
  ActorRole,
  ChannelDeclaration,
  ChannelTypeDecl,
  PersistencePolicy,
} from './types';

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const VALID_TYPE_PATTERN = /^(string|number|boolean|json)\??$|^enum:[^|]+(\|[^|]+)*\??$/;
const VALID_PERSIST: ReadonlySet<PersistencePolicy> = new Set([
  'transient',
  'logged',
  'sampled',
]);

/**
 * Declare a channel. Returns the same object (typed); the function
 * exists to enforce shape at the call site and to give us a single
 * place to add validation later.
 *
 * Usage:
 *
 *   export const decisionUpdated = declareChannel({
 *     name: 'decision-updated',
 *     payload: { decisionId: 'string', kind: 'enum:created|updated|deleted' },
 *     scope:   { decisionId: 'string' },
 *     publishers: ['operation', 'system'],
 *     subscribers: ['controller', 'agent-surface'],
 *     persist: 'transient',
 *     description: 'Decision graph mutated.',
 *   } as const);
 */
export function declareChannel<T extends ChannelDeclaration>(decl: T): T {
  validateDeclaration(decl);
  return decl;
}

function validateDeclaration(decl: ChannelDeclaration): void {
  if (!NAME_PATTERN.test(decl.name)) {
    throw new Error(
      `[declareChannel] invalid name "${decl.name}" — must be kebab-case starting with a letter`,
    );
  }

  for (const [key, type] of Object.entries(decl.payload)) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(
        `[declareChannel:${decl.name}] invalid payload key "${key}" — must be camelCase`,
      );
    }
    if (!VALID_TYPE_PATTERN.test(type as string)) {
      throw new Error(
        `[declareChannel:${decl.name}] invalid payload type "${type}" for key "${key}"`,
      );
    }
  }

  for (const [key, type] of Object.entries(decl.scope)) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(
        `[declareChannel:${decl.name}] invalid scope key "${key}" — must be camelCase`,
      );
    }
    if (!VALID_TYPE_PATTERN.test(type as string)) {
      throw new Error(
        `[declareChannel:${decl.name}] invalid scope type "${type}" for key "${key}"`,
      );
    }
    if (!(key in decl.payload)) {
      throw new Error(
        `[declareChannel:${decl.name}] scope key "${key}" must also appear in payload (scope values ride in the payload)`,
      );
    }
  }

  if (!VALID_PERSIST.has(decl.persist)) {
    throw new Error(
      `[declareChannel:${decl.name}] invalid persist "${decl.persist}" — must be one of: transient | logged | sampled`,
    );
  }

  if (!decl.description || decl.description.trim().length === 0) {
    throw new Error(
      `[declareChannel:${decl.name}] description is required (used by M4 agent introspection)`,
    );
  }
}

// Re-export the runtime value-validator so the publish path can reuse it.
export function valueMatchesType(value: unknown, type: ChannelTypeDecl): boolean {
  const t = String(type);
  const optional = t.endsWith('?');
  const baseType = optional ? t.slice(0, -1) : t;

  if (value === null || value === undefined) {
    return optional;
  }

  if (baseType.startsWith('enum:')) {
    const allowed = baseType.slice('enum:'.length).split('|');
    return typeof value === 'string' && allowed.includes(value);
  }

  switch (baseType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return (
        value === null ||
        ['string', 'number', 'boolean', 'object'].includes(typeof value)
      );
    default:
      return false;
  }
}
