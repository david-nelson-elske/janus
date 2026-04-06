/**
 * Duration values in milliseconds with a branded type.
 *
 * Used for configuration: `Volatile({ retain: minutes(5) })`, `.audit({ retain: days(90) })`.
 * This is NOT the Duration semantic type (which declares a field that holds a duration).
 */

/** Branded type — a number known to represent milliseconds. */
export type DurationMs = number & { readonly __brand: 'DurationMs' };

function ms(n: number): DurationMs {
  return n as DurationMs;
}

export function seconds(n: number): DurationMs {
  return ms(n * 1_000);
}
export function minutes(n: number): DurationMs {
  return ms(n * 60_000);
}
export function hours(n: number): DurationMs {
  return ms(n * 3_600_000);
}
export function days(n: number): DurationMs {
  return ms(n * 86_400_000);
}
export function weeks(n: number): DurationMs {
  return ms(n * 604_800_000);
}

const UNIT_MAP: Record<string, (n: number) => DurationMs> = {
  s: seconds,
  m: minutes,
  h: hours,
  d: days,
  w: weeks,
};

/**
 * Parse a shorthand duration string: '90d', '1h30m', '5m'.
 * Compound expressions are additive: '1h30m' = 1 hour + 30 minutes.
 */
export function parseDuration(input: string | number): DurationMs {
  if (typeof input === 'number') return ms(input);
  let total = 0;
  let matched = false;
  for (const [, digits, unit] of input.matchAll(/(\d+(?:\.\d+)?)\s*([smhdw])/gi)) {
    const value = Number.parseFloat(digits);
    const fn = UNIT_MAP[unit.toLowerCase()];
    if (fn) {
      total += fn(value) as number;
      matched = true;
    }
  }
  if (!matched) throw new Error(`Invalid duration: "${input}"`);
  return ms(total);
}
