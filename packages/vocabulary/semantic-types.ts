/**
 * Semantic types — typed constructors that define what kind of DATA a field holds.
 *
 * They drive validation, persistence column types, serialization, search indexing,
 * and field role inference. Each constructor returns a frozen discriminated union member.
 */

// ── Common hints ─────────────────────────────────────────────────

export type FieldRole =
  | 'title'
  | 'subtitle'
  | 'timestamp'
  | 'badge'
  | 'image'
  | 'amount'
  | 'body'
  | 'summary';

export interface FieldHints {
  readonly required?: boolean;
  readonly default?: unknown;
  readonly as?: FieldRole;
  readonly searchable?: boolean;
  readonly boost?: number;
  readonly indexed?: boolean;
  readonly unique?: boolean;
  readonly label?: string;
  readonly description?: string;
}

function freeze<T extends object>(obj: T): Readonly<T> {
  return Object.freeze(obj);
}

function field<K extends string>(
  kind: K,
  hints: FieldHints = {},
): { kind: K; hints: Readonly<FieldHints> } {
  return freeze({ kind, hints: freeze(hints) });
}

// ── Value Types ──────────────────────────────────────────────────

export interface StrHints extends FieldHints {
  readonly multiline?: boolean;
}
export interface StrField {
  readonly kind: 'str';
  readonly hints: Readonly<StrHints>;
}
export function Str(hints?: StrHints): StrField {
  return freeze({ kind: 'str' as const, hints: freeze(hints ?? {}) });
}

export interface IntField {
  readonly kind: 'int';
  readonly hints: Readonly<FieldHints>;
}
export function Int(hints?: FieldHints): IntField {
  return field('int', hints) as IntField;
}

export interface FloatField {
  readonly kind: 'float';
  readonly hints: Readonly<FieldHints>;
}
export function Float(hints?: FieldHints): FloatField {
  return field('float', hints) as FloatField;
}

export interface BoolField {
  readonly kind: 'bool';
  readonly hints: Readonly<FieldHints>;
}
export function Bool(hints?: FieldHints): BoolField {
  return field('bool', hints) as BoolField;
}

export interface EnumField {
  readonly kind: 'enum';
  readonly values: readonly string[];
  readonly hints: Readonly<FieldHints>;
}
export function Enum(values: readonly string[], hints?: FieldHints): EnumField {
  return freeze({
    kind: 'enum' as const,
    values: Object.freeze([...values]),
    hints: freeze(hints ?? {}),
  });
}

export interface JsonField {
  readonly kind: 'json';
  readonly hints: Readonly<FieldHints>;
}
export function Json(hints?: FieldHints): JsonField {
  return field('json', hints) as JsonField;
}

// ── Temporal Types ───────────────────────────────────────────────

export interface DateTimeHints extends FieldHints {
  readonly decay?: string;
}
export interface DateTimeField {
  readonly kind: 'datetime';
  readonly hints: Readonly<DateTimeHints>;
}
export function DateTime(hints?: DateTimeHints): DateTimeField {
  return freeze({ kind: 'datetime' as const, hints: freeze(hints ?? {}) });
}

export interface DurationField {
  readonly kind: 'duration';
  readonly hints: Readonly<FieldHints>;
}
/**
 * Declares a field that HOLDS a duration value.
 * Not to be confused with `minutes()`/`hours()` which PRODUCE duration values for config.
 */
export function Duration(hints?: FieldHints): DurationField {
  return field('duration', hints) as DurationField;
}

// ── Monetary Types ───────────────────────────────────────────────

export interface IntCentsField {
  readonly kind: 'intcents';
  readonly hints: Readonly<FieldHints>;
}
export function IntCents(hints?: FieldHints): IntCentsField {
  return field('intcents', hints) as IntCentsField;
}

export interface IntBpsField {
  readonly kind: 'intbps';
  readonly hints: Readonly<FieldHints>;
}
export function IntBps(hints?: FieldHints): IntBpsField {
  return field('intbps', hints) as IntBpsField;
}

// ── Identity Types ───────────────────────────────────────────────

export interface IdField {
  readonly kind: 'id';
  readonly hints: Readonly<FieldHints>;
}
export function Id(hints?: FieldHints): IdField {
  return field('id', hints) as IdField;
}

export interface SlugField {
  readonly kind: 'slug';
  readonly hints: Readonly<FieldHints>;
}
export function Slug(hints?: FieldHints): SlugField {
  return field('slug', hints) as SlugField;
}

export interface EmailField {
  readonly kind: 'email';
  readonly hints: Readonly<FieldHints>;
}
export function Email(hints?: FieldHints): EmailField {
  return field('email', hints) as EmailField;
}

export interface PhoneField {
  readonly kind: 'phone';
  readonly hints: Readonly<FieldHints>;
}
export function Phone(hints?: FieldHints): PhoneField {
  return field('phone', hints) as PhoneField;
}

export interface UrlField {
  readonly kind: 'url';
  readonly hints: Readonly<FieldHints>;
}
export function Url(hints?: FieldHints): UrlField {
  return field('url', hints) as UrlField;
}

export interface TokenHints extends FieldHints {
  readonly prefix?: string;
  readonly length?: number;
  readonly expires?: string | number;
}
export interface TokenField {
  readonly kind: 'token';
  readonly hints: Readonly<TokenHints>;
}
export function Token(hints?: TokenHints): TokenField {
  return freeze({ kind: 'token' as const, hints: freeze(hints ?? {}) });
}

export interface ScopeField {
  readonly kind: 'scope';
  readonly hints: Readonly<FieldHints>;
}
export function Scope(hints?: FieldHints): ScopeField {
  return field('scope', hints) as ScopeField;
}

// ── Content Types ────────────────────────────────────────────────

export interface MarkdownField {
  readonly kind: 'markdown';
  readonly hints: Readonly<FieldHints>;
}
export function Markdown(hints?: FieldHints): MarkdownField {
  return field('markdown', hints) as MarkdownField;
}

export interface CronField {
  readonly kind: 'cron';
  readonly hints: Readonly<FieldHints>;
}
export function Cron(hints?: FieldHints): CronField {
  return field('cron', hints) as CronField;
}

export interface AssetHints extends FieldHints {
  readonly accept?: string;
  readonly maxSize?: number;
}
export interface AssetField {
  readonly kind: 'asset';
  readonly hints: Readonly<AssetHints>;
}
export function Asset(hints?: AssetHints): AssetField {
  return freeze({ kind: 'asset' as const, hints: freeze(hints ?? {}) });
}

// ── Template Type (ADR 10b) ─────────────────────────────────────

export interface TemplateHints extends FieldHints {
  readonly format?: 'html' | 'markdown' | 'text';
}
export interface TemplateField {
  readonly kind: 'template';
  readonly hints: Readonly<TemplateHints>;
}
export function Template(hints?: TemplateHints): TemplateField {
  return freeze({ kind: 'template' as const, hints: freeze(hints ?? {}) });
}

// ── Visual Types ─────────────────────────────────────────────────

export interface ColorField {
  readonly kind: 'color';
  readonly hints: Readonly<FieldHints>;
}
export function Color(hints?: FieldHints): ColorField {
  return field('color', hints) as ColorField;
}

export interface IconField {
  readonly kind: 'icon';
  readonly hints: Readonly<FieldHints>;
}
export function Icon(hints?: FieldHints): IconField {
  return field('icon', hints) as IconField;
}

// ── Compound Types ───────────────────────────────────────────────

export interface RecurrenceField {
  readonly kind: 'recurrence';
  readonly target: string;
  readonly hints: Readonly<FieldHints>;
}
export function Recurrence(target: string, hints?: FieldHints): RecurrenceField {
  return freeze({ kind: 'recurrence' as const, target, hints: freeze(hints ?? {}) });
}

export interface AvailabilityField {
  readonly kind: 'availability';
  readonly hints: Readonly<FieldHints>;
}
export function Availability(hints?: FieldHints): AvailabilityField {
  return field('availability', hints) as AvailabilityField;
}

export interface QrCodeHints extends FieldHints {
  readonly length?: number;
  readonly format?: 'alphanumeric' | 'numeric';
  readonly singleUse?: boolean;
  readonly expiresWith?: string;
}
export interface QrCodeField {
  readonly kind: 'qrcode';
  readonly hints: Readonly<QrCodeHints>;
}
export function QrCode(hints?: QrCodeHints): QrCodeField {
  return freeze({ kind: 'qrcode' as const, hints: freeze(hints ?? {}) });
}

export interface LatLngField {
  readonly kind: 'latlng';
  readonly hints: Readonly<FieldHints>;
}
export function LatLng(hints?: FieldHints): LatLngField {
  return field('latlng', hints) as LatLngField;
}

// ── The union ────────────────────────────────────────────────────

export type SemanticField =
  | StrField
  | IntField
  | FloatField
  | BoolField
  | EnumField
  | JsonField
  | DateTimeField
  | DurationField
  | IntCentsField
  | IntBpsField
  | IdField
  | SlugField
  | EmailField
  | PhoneField
  | UrlField
  | TokenField
  | ScopeField
  | MarkdownField
  | CronField
  | AssetField
  | TemplateField
  | ColorField
  | IconField
  | RecurrenceField
  | AvailabilityField
  | QrCodeField
  | LatLngField;

export type SemanticFieldKind = SemanticField['kind'];

const SEMANTIC_KINDS = new Set<string>([
  'str',
  'int',
  'float',
  'bool',
  'enum',
  'json',
  'datetime',
  'duration',
  'intcents',
  'intbps',
  'id',
  'slug',
  'email',
  'phone',
  'url',
  'token',
  'scope',
  'markdown',
  'cron',
  'asset',
  'template',
  'color',
  'icon',
  'recurrence',
  'availability',
  'qrcode',
  'latlng',
]);

export function isSemanticField(value: unknown): value is SemanticField {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    typeof (value as { kind: unknown }).kind === 'string' &&
    SEMANTIC_KINDS.has((value as { kind: string }).kind)
  );
}

// ── Runtime validation ──────────────────────────────────────────

/**
 * Validate a runtime value against a semantic field's type contract.
 * Returns an error message string, or null if valid.
 */
export function validateSemanticValue(field: SemanticField, value: unknown): string | null {
  switch (field.kind) {
    case 'str':
    case 'markdown':
    case 'slug':
    case 'cron':
    case 'color':
    case 'icon':
    case 'scope':
    case 'url':
    case 'phone':
    case 'id':
    case 'token':
      return typeof value === 'string' ? null : 'must be a string';

    case 'email':
      if (typeof value !== 'string') return 'must be a string';
      return (value as string).includes('@') ? null : 'invalid email format';

    case 'int':
    case 'intcents':
    case 'intbps':
      return typeof value === 'number' && Number.isInteger(value) ? null : 'must be an integer';

    case 'float':
      return typeof value === 'number' ? null : 'must be a number';

    case 'bool':
      return typeof value === 'boolean' ? null : 'must be a boolean';

    case 'enum':
      if (typeof value !== 'string') return `must be one of: ${field.values.join(', ')}`;
      return field.values.includes(value) ? null : `must be one of: ${field.values.join(', ')}`;

    case 'datetime':
      return typeof value === 'string' ? null : 'must be an ISO 8601 string';

    case 'json':
    case 'duration':
    case 'asset':
    case 'recurrence':
    case 'availability':
    case 'qrcode':
    case 'latlng':
      return null; // complex/opaque — accepted as-is

    default: {
      const _exhaustive: never = field;
      return null;
    }
  }
}
