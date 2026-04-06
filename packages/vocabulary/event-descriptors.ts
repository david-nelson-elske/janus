/**
 * Event descriptors — typed constructors that reference what HAPPENED to an entity.
 *
 * Used in `.on()` (reactions), `.observe()` (metrics), `.rateLimit()` (throttling),
 * `.audit()` (mutation history), and cache invalidation.
 */

// ── The discriminated union ──────────────────────────────────────

export type EventDescriptor =
  | { readonly kind: 'created' }
  | { readonly kind: 'updated' }
  | { readonly kind: 'deleted' }
  | {
      readonly kind: 'transitioned';
      readonly to?: string;
      readonly from?: string;
      readonly field?: string;
    }
  | { readonly kind: 'browsed' }
  | { readonly kind: 'retrieved' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'refreshed' }
  | { readonly kind: 'synced' }
  | { readonly kind: 'acted'; readonly name: string }
  | { readonly kind: 'action-invoked'; readonly name: string };

export type EventDescriptorKind = EventDescriptor['kind'];

// ── Singleton constants (parameterless) ──────────────────────────

export const Created: EventDescriptor = Object.freeze({ kind: 'created' as const });
export const Updated: EventDescriptor = Object.freeze({ kind: 'updated' as const });
export const Deleted: EventDescriptor = Object.freeze({ kind: 'deleted' as const });
export const Browsed: EventDescriptor = Object.freeze({ kind: 'browsed' as const });
export const Retrieved: EventDescriptor = Object.freeze({ kind: 'retrieved' as const });
export const Expired: EventDescriptor = Object.freeze({ kind: 'expired' as const });
export const Refreshed: EventDescriptor = Object.freeze({ kind: 'refreshed' as const });
export const Synced: EventDescriptor = Object.freeze({ kind: 'synced' as const });

// ── Parameterized constructors ───────────────────────────────────

/**
 * Lifecycle transition event.
 *
 * - `Transitioned()` — matches any transition
 * - `Transitioned('published')` — matches any → published
 * - `Transitioned('published', 'draft')` — matches draft → published
 * - `Transitioned('captured', { field: 'paymentStatus' })` — matches on specific lifecycle field
 */
export function Transitioned(
  to?: string,
  fromOrOptions?: string | { field: string },
): EventDescriptor {
  const base: { kind: 'transitioned'; to?: string; from?: string; field?: string } = {
    kind: 'transitioned',
  };
  if (to !== undefined) base.to = to;
  if (typeof fromOrOptions === 'string') {
    base.from = fromOrOptions;
  } else if (fromOrOptions && typeof fromOrOptions === 'object' && 'field' in fromOrOptions) {
    base.field = fromOrOptions.field;
  }
  return Object.freeze(base);
}

/** Custom action event. */
export function Acted(name: string): EventDescriptor {
  return Object.freeze({ kind: 'acted' as const, name });
}

/** Action invocation event — fires on successful action completion. */
export function ActionInvoked(name: string): EventDescriptor {
  return Object.freeze({ kind: 'action-invoked' as const, name });
}

export function isActionInvoked(
  d: EventDescriptor,
): d is Extract<EventDescriptor, { kind: 'action-invoked' }> {
  return d.kind === 'action-invoked';
}

// ── Type narrowing helpers ───────────────────────────────────────

export function isTransitioned(
  d: EventDescriptor,
): d is Extract<EventDescriptor, { kind: 'transitioned' }> {
  return d.kind === 'transitioned';
}

const MUTATION_KINDS = new Set<EventDescriptorKind>([
  'created',
  'updated',
  'deleted',
  'transitioned',
  'action-invoked',
]);
const QUERY_KINDS = new Set<EventDescriptorKind>(['browsed', 'retrieved']);
const FRAMEWORK_KINDS = new Set<EventDescriptorKind>(['expired', 'refreshed', 'synced']);

export function isMutationEvent(d: EventDescriptor): boolean {
  return MUTATION_KINDS.has(d.kind);
}
export function isQueryEvent(d: EventDescriptor): boolean {
  return QUERY_KINDS.has(d.kind);
}
export function isFrameworkEvent(d: EventDescriptor): boolean {
  return FRAMEWORK_KINDS.has(d.kind);
}
