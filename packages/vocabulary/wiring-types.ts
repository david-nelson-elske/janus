/**
 * Wiring types — typed constructors that declare structural relationships between entities.
 *
 * The strength gradient is explicit: Relation (FK, cascade, include) > Reference (typed soft) > Mention (polymorphic soft).
 * These simultaneously declare a storage column AND a graph edge.
 */

// ── The discriminated union ──────────────────────────────────────

export type WiringType = RelationField | ReferenceField | MentionField;

export type WiringFieldKind = WiringType['kind'];

// ── Wiring effects — cross-entity lifecycle (ADR 01d) ───────────

export type OnDeletePolicy = 'restrict' | 'cascade' | 'nullify';

export type TransitionAction = 'nullify' | 'cascade' | { readonly transition: string };

export interface WiringEffects {
  /** What happens to referencing records when the referenced entity is deleted. */
  readonly deleted?: OnDeletePolicy;
  /** What happens to referencing records when the referenced entity transitions to a named state. */
  readonly transitioned?: Readonly<Record<string, TransitionAction>>;
}

// ── Relation — structural reference with FK ──────────────────────

export interface RelationField {
  readonly kind: 'relation';
  readonly target: string;
  readonly cascade: OnDeletePolicy;
  readonly effects?: WiringEffects;
  readonly label?: string;
}

export function Relation(
  target: string,
  config?: { cascade?: OnDeletePolicy; effects?: WiringEffects; label?: string },
): RelationField {
  // Validate: both cascade and effects.deleted provided is ambiguous
  if (config?.cascade && config?.effects?.deleted) {
    throw new Error(
      `Conflicting effect config: both 'cascade' (${config.cascade}) and 'effects.deleted' (${config.effects.deleted}) provided. Use one or the other.`,
    );
  }
  const deleted = config?.effects?.deleted ?? config?.cascade ?? 'restrict';
  const effects = config?.effects
    ? Object.freeze(config.effects)
    : undefined;
  return Object.freeze({
    kind: 'relation' as const,
    target,
    cascade: deleted,
    effects,
    label: config?.label,
  });
}

// ── Reference — typed soft reference (no FK) ─────────────────────

export interface ReferenceField {
  readonly kind: 'reference';
  readonly target: string;
  readonly effects?: WiringEffects;
  readonly label?: string;
}

export function Reference(target: string, config?: { effects?: WiringEffects; label?: string }): ReferenceField {
  return Object.freeze({
    kind: 'reference' as const,
    target,
    effects: config?.effects ? Object.freeze(config.effects) : undefined,
    label: config?.label,
  });
}

// ── Mention — polymorphic soft reference (no FK) ─────────────────

export interface MentionField {
  readonly kind: 'mention';
  readonly allowed: readonly string[];
  readonly label?: string;
}

export function Mention(config: { allowed: readonly string[]; label?: string }): MentionField {
  return Object.freeze({
    kind: 'mention' as const,
    allowed: Object.freeze([...config.allowed]),
    label: config.label,
  });
}

// ── Type guards ──────────────────────────────────────────────────

export function isWiringType(value: unknown): value is WiringType {
  return isRelation(value) || isReference(value) || isMention(value);
}

export function isRelation(value: unknown): value is RelationField {
  return (
    typeof value === 'object' && value !== null && (value as { kind: unknown }).kind === 'relation'
  );
}

export function isReference(value: unknown): value is ReferenceField {
  return (
    typeof value === 'object' && value !== null && (value as { kind: unknown }).kind === 'reference'
  );
}

export function isMention(value: unknown): value is MentionField {
  return (
    typeof value === 'object' && value !== null && (value as { kind: unknown }).kind === 'mention'
  );
}

/**
 * Validate a runtime value against a wiring field's type contract.
 * All wiring types store an entity ID (string).
 * Returns an error message string, or null if valid.
 */
export function validateWiringValue(_field: WiringType, value: unknown): string | null {
  return typeof value === 'string' ? null : 'must be a string (entity ID)';
}
