/**
 * Minimal five-field cron expression parser.
 *
 * Format: minute hour day-of-month month day-of-week
 *   minute:       0-59
 *   hour:         0-23
 *   day-of-month: 1-31
 *   month:        1-12
 *   day-of-week:  0-6 (0 = Sunday)
 *
 * Supports: *, N, N-M, N/S, N-M/S, N,M,O
 *
 * STABLE — ADR 07. Used by the scheduler for cron-triggered subscriptions.
 */

export interface CronFields {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dayOfMonth: readonly number[];
  readonly month: readonly number[];
  readonly dayOfWeek: readonly number[];
}

function parseField(field: string, min: number, max: number): readonly number[] {
  const result: number[] = [];

  for (const part of field.split(',')) {
    const trimmed = part.trim();

    if (trimmed.includes('/')) {
      const [range, stepStr] = trimmed.split('/');
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const [a, b] = range.split('-').map(Number);
          start = a;
          end = b;
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) result.push(i);
    } else if (trimmed === '*') {
      for (let i = min; i <= max; i++) result.push(i);
    } else if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(Number);
      for (let i = start; i <= end; i++) result.push(i);
    } else {
      result.push(parseInt(trimmed, 10));
    }
  }

  return Object.freeze([...new Set(result)].sort((a, b) => a - b));
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  return Object.freeze({
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  });
}

export function cronMatchesDate(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.includes(date.getMinutes()) &&
    fields.hour.includes(date.getHours()) &&
    fields.dayOfMonth.includes(date.getDate()) &&
    fields.month.includes(date.getMonth() + 1) &&
    fields.dayOfWeek.includes(date.getDay())
  );
}

/**
 * Find the next minute (after `after`) that matches the cron expression.
 * Starts from the next whole minute after `after`.
 */
export function nextCronMatch(fields: CronFields, after: Date): Date {
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Brute-force: check each minute for up to 1 year
  const maxIterations = 525_600;
  for (let i = 0; i < maxIterations; i++) {
    if (cronMatchesDate(fields, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error('No cron match found within 1 year');
}
