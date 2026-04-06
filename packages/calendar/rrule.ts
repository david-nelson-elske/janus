/**
 * Minimal RRULE expander for common recurrence patterns.
 *
 * Handles FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with BYDAY, BYMONTHDAY,
 * UNTIL, COUNT, and INTERVAL. Covers the patterns used by community
 * organizations: weekly programs, monthly meetings, seasonal schedules.
 *
 * For full RFC 5545 RRULE compliance, replace with the `rrule` npm package.
 */

export interface ParsedRRule {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  readonly interval: number;
  readonly until?: Date;
  readonly count?: number;
  readonly byDay?: readonly string[];
  readonly byMonthDay?: readonly number[];
  readonly byMonth?: readonly number[];
}

export interface ExpandOptions {
  readonly start: Date;
  readonly horizon?: Date;
  readonly maxInstances?: number;
}

const DAY_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

export function parseRRule(rrule: string): ParsedRRule {
  const rule = rrule.startsWith('RRULE:') ? rrule.slice(6) : rrule;
  const parts = rule.split(';');
  const params = new Map<string, string>();

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }

  const freq = params.get('FREQ') as ParsedRRule['freq'];
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    throw new Error(`Unsupported or missing FREQ in RRULE: ${rrule}`);
  }

  const interval = params.has('INTERVAL') ? parseInt(params.get('INTERVAL')!, 10) : 1;

  let until: Date | undefined;
  if (params.has('UNTIL')) {
    const u = params.get('UNTIL')!;
    const y = parseInt(u.slice(0, 4), 10);
    const m = parseInt(u.slice(4, 6), 10) - 1;
    const d = parseInt(u.slice(6, 8), 10);
    if (u.length > 8) {
      const h = parseInt(u.slice(9, 11), 10);
      const min = parseInt(u.slice(11, 13), 10);
      const s = parseInt(u.slice(13, 15), 10);
      until = new Date(Date.UTC(y, m, d, h, min, s));
    } else {
      until = new Date(Date.UTC(y, m, d, 23, 59, 59));
    }
  }

  const count = params.has('COUNT') ? parseInt(params.get('COUNT')!, 10) : undefined;
  const byDay = params.has('BYDAY')
    ? params.get('BYDAY')!.split(',').map((d) => d.trim().toUpperCase())
    : undefined;
  const byMonthDay = params.has('BYMONTHDAY')
    ? params.get('BYMONTHDAY')!.split(',').map((d) => parseInt(d.trim(), 10))
    : undefined;
  const byMonth = params.has('BYMONTH')
    ? params.get('BYMONTH')!.split(',').map((m) => parseInt(m.trim(), 10))
    : undefined;

  return { freq, interval, until, count, byDay, byMonthDay, byMonth };
}

function addInterval(date: Date, freq: ParsedRRule['freq'], interval: number): Date {
  const d = new Date(date.getTime());
  switch (freq) {
    case 'DAILY': d.setUTCDate(d.getUTCDate() + interval); break;
    case 'WEEKLY': d.setUTCDate(d.getUTCDate() + 7 * interval); break;
    case 'MONTHLY': d.setUTCMonth(d.getUTCMonth() + interval); break;
    case 'YEARLY': d.setUTCFullYear(d.getUTCFullYear() + interval); break;
  }
  return d;
}

function matchesByDay(date: Date, byDay: readonly string[]): boolean {
  return byDay.some((day) => DAY_INDEX[day] === date.getUTCDay());
}

function matchesByMonthDay(date: Date, byMonthDay: readonly number[]): boolean {
  return byMonthDay.includes(date.getUTCDate());
}

function matchesByMonth(date: Date, byMonth: readonly number[]): boolean {
  return byMonth.includes(date.getUTCMonth() + 1);
}

export function expandRRule(rrule: string, options: ExpandOptions): readonly Date[] {
  const parsed = parseRRule(rrule);
  const { start, horizon, maxInstances = 365 } = options;
  const maxDate = parsed.until ?? horizon ?? new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000);
  const maxCount = parsed.count ?? maxInstances;
  const dates: Date[] = [];

  if (parsed.freq === 'WEEKLY' && parsed.byDay) {
    let weekStart = new Date(start.getTime());
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());

    while (dates.length < maxCount) {
      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const candidate = new Date(weekStart.getTime());
        candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
        candidate.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds());

        if (candidate.getTime() < start.getTime()) continue;
        if (candidate.getTime() > maxDate.getTime()) return dates;
        if (dates.length >= maxCount) return dates;

        if (matchesByDay(candidate, parsed.byDay)) {
          if (!parsed.byMonth || matchesByMonth(candidate, parsed.byMonth)) {
            dates.push(candidate);
          }
        }
      }
      weekStart = new Date(weekStart.getTime());
      weekStart.setUTCDate(weekStart.getUTCDate() + 7 * parsed.interval);
    }
  } else if (parsed.freq === 'MONTHLY' && parsed.byMonthDay) {
    let current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

    while (dates.length < maxCount) {
      for (const day of parsed.byMonthDay) {
        const candidate = new Date(Date.UTC(
          current.getUTCFullYear(), current.getUTCMonth(), day,
          start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(),
        ));

        if (candidate.getUTCMonth() !== current.getUTCMonth()) continue;
        if (candidate.getTime() < start.getTime()) continue;
        if (candidate.getTime() > maxDate.getTime()) return dates;
        if (dates.length >= maxCount) return dates;

        if (!parsed.byMonth || matchesByMonth(candidate, parsed.byMonth)) {
          dates.push(candidate);
        }
      }
      current.setUTCMonth(current.getUTCMonth() + parsed.interval);
    }
  } else {
    let current = new Date(start.getTime());

    while (dates.length < maxCount) {
      if (current.getTime() > maxDate.getTime()) break;

      let matches = true;
      if (parsed.byDay && !matchesByDay(current, parsed.byDay)) matches = false;
      if (parsed.byMonthDay && !matchesByMonthDay(current, parsed.byMonthDay)) matches = false;
      if (parsed.byMonth && !matchesByMonth(current, parsed.byMonth)) matches = false;

      if (matches) dates.push(new Date(current.getTime()));
      current = addInterval(current, parsed.freq, parsed.interval);
    }
  }

  return dates;
}
