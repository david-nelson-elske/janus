/**
 * Channel type vocabulary — the typing primitives a channel
 * declaration uses for its payload and scope keys.
 *
 * v1.5 grows in lock-step with the controller/projection type
 * vocabulary. M3 (projections) will subsume hand-typed payloads with
 * `payload: projection(decisionView)` but the vocabulary stays.
 */

/**
 * The set of types a payload or scope field may take. Strings prefixed
 * `enum:` enumerate allowed string values, pipe-separated:
 * `'enum:created|updated|deleted'`. The trailing `?` marks the field
 * optional (nullable / undefined).
 */
export type ChannelTypeDecl =
  | 'string'
  | 'string?'
  | 'number'
  | 'number?'
  | 'boolean'
  | 'boolean?'
  | 'json'
  | 'json?'
  // Enum literal type; runtime validates via VALID_TYPE_PATTERN in declare.ts
  | `enum:${string}`
  | `enum:${string}?`;

/**
 * Actor role names that may appear in `publishers` / `subscribers`.
 * Free-form in v1.5; M5 reads these into the compiled capability graph.
 *
 * Note: `string` widens the union so apps can introduce custom actor
 * names without recompiling the framework. Validation is intentionally
 * loose at v1.5 — the capability graph M5 will enforce.
 */
export type ActorRole =
  | 'operation'
  | 'system'
  | 'controller'
  | 'agent-surface'
  | 'test'
  | (string & {});

/**
 * Per-channel persistence policy. Logged channels mint an
 * `interaction_event` row per publish; sampled does so at a
 * configurable rate; transient drops after fan-out.
 */
export type PersistencePolicy = 'transient' | 'logged' | 'sampled';

/**
 * The complete channel declaration shape. See
 * `.planning/CHANNEL-DECLARATIONS.md` §5 for documentation of each
 * field and the migration roadmap to projection-typed payloads at M3.
 */
export interface ChannelDeclaration {
  /** Stable kebab-case identifier referenced from publishes, subscribes, manifests. */
  readonly name: string;

  /** Payload field types. Scope keys must also appear here. */
  readonly payload: Readonly<Record<string, ChannelTypeDecl>>;

  /** Scope keys for fan-out matching. Subset of payload keys. */
  readonly scope: Readonly<Record<string, ChannelTypeDecl>>;

  /** Actor roles allowed to publish. M5 compiles into capability triples. */
  readonly publishers: readonly ActorRole[];

  /** Actor roles allowed to subscribe. M5 compiles into capability triples. */
  readonly subscribers: readonly ActorRole[];

  /** Persistence policy: drop / log / sample. */
  readonly persist: PersistencePolicy;

  /**
   * Sampling rate when `persist === 'sampled'`. Integer N means 1-in-N.
   * Ignored otherwise.
   */
  readonly sampleRate?: number;

  /**
   * Retention in days for `logged` / `sampled` channels. Defaults to
   * 30 in the retention job; per-channel override here.
   */
  readonly retentionDays?: number;

  /**
   * Free-form description. M4's agent introspection reads this to know
   * what each channel carries before subscribing.
   */
  readonly description: string;
}

// ── Payload/scope inference ──────────────────────────────────────

type Required<T extends string> = T extends `${infer _}?` ? never : T;
type IsOptional<T extends string> = T extends `${infer _}?` ? true : false;

type BaseOf<T extends string> = T extends `${infer Base}?` ? Base : T;
type EnumValuesOf<T extends string> = T extends `enum:${infer Members}`
  ? Members extends `${infer Head}|${infer Tail}`
    ? Head | EnumValuesOf<`enum:${Tail}`>
    : Members
  : never;

type ValueOfType<T extends string> =
  BaseOf<T> extends 'string'
    ? string
    : BaseOf<T> extends 'number'
      ? number
      : BaseOf<T> extends 'boolean'
        ? boolean
        : BaseOf<T> extends 'json'
          ? unknown
          : BaseOf<T> extends `enum:${string}`
            ? EnumValuesOf<BaseOf<T>>
            : never;

/**
 * Infer the TypeScript payload type from a declaration's `payload` map.
 * Optional fields become `field?: T`; required fields stay required.
 */
export type PayloadOf<D extends ChannelDeclaration> = {
  [K in keyof D['payload'] as IsOptional<D['payload'][K] & string> extends true
    ? never
    : K]: ValueOfType<D['payload'][K] & string>;
} & {
  [K in keyof D['payload'] as IsOptional<D['payload'][K] & string> extends true
    ? K
    : never]?: ValueOfType<D['payload'][K] & string>;
};

/** Scope shape — subset of payload, but always Required here since publish always carries all scope keys. */
export type ScopeOf<D extends ChannelDeclaration> = {
  [K in keyof D['scope']]: ValueOfType<D['scope'][K] & string>;
};

// Helper to keep tsc from complaining about unused `Required` alias.
type _Keep = Required<'string'>;
