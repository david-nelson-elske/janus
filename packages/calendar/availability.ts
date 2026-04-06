/**
 * Availability validation — pure functions for temporal constraint checking.
 *
 * No store or pipeline dependency. The composition layer provides the data
 * and acts on the results.
 */

// ── Types ──────────────────────────────────────────────────────

export interface AvailabilityWindow {
  readonly day: string;
  readonly start: string;
  readonly end: string;
}

export interface AvailabilityData {
  readonly windows: readonly AvailabilityWindow[];
  readonly blackouts: readonly string[];
}

export interface AvailabilityCheckResult {
  readonly available: boolean;
  readonly violations: readonly AvailabilityViolation[];
}

export interface AvailabilityViolation {
  readonly kind: 'outside-window' | 'blackout' | 'lead-time' | 'horizon' | 'conflict';
  readonly message: string;
}

export interface AvailabilityConstraints {
  readonly leadTimeMinutes?: number;
  readonly horizonDays?: number;
}

export interface ExistingBooking {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

// ── Validation ─────────────────────────────────────────────────

const DAY_NAMES: Record<number, string> = {
  0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat',
};

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function checkAvailability(
  availability: AvailabilityData,
  request: { readonly start: number; readonly end: number },
  constraints: AvailabilityConstraints,
  existingBookings: readonly ExistingBooking[],
  now?: number,
): AvailabilityCheckResult {
  const violations: AvailabilityViolation[] = [];
  const currentTime = now ?? Date.now();

  // 1. Lead time
  if (constraints.leadTimeMinutes != null) {
    const minStart = currentTime + constraints.leadTimeMinutes * 60 * 1000;
    if (request.start < minStart) {
      violations.push({
        kind: 'lead-time',
        message: `Booking must be at least ${constraints.leadTimeMinutes} minutes in advance.`,
      });
    }
  }

  // 2. Horizon
  if (constraints.horizonDays != null) {
    const maxStart = currentTime + constraints.horizonDays * 24 * 60 * 60 * 1000;
    if (request.start > maxStart) {
      violations.push({
        kind: 'horizon',
        message: `Booking must be within ${constraints.horizonDays} days from now.`,
      });
    }
  }

  // 3. Window check
  if (availability.windows.length > 0) {
    const startDate = new Date(request.start);
    const endDate = new Date(request.end);
    const dayName = DAY_NAMES[startDate.getUTCDay()];

    const matchingWindows = availability.windows.filter((w) => w.day.toLowerCase() === dayName);

    if (matchingWindows.length === 0) {
      violations.push({
        kind: 'outside-window',
        message: `No availability windows on ${dayName}.`,
      });
    } else {
      const startMinutes = startDate.getUTCHours() * 60 + startDate.getUTCMinutes();
      const endMinutes = endDate.getUTCHours() * 60 + endDate.getUTCMinutes();

      const fitsWindow = matchingWindows.some((w) => {
        const windowStart = timeToMinutes(w.start);
        const windowEnd = timeToMinutes(w.end);
        return startMinutes >= windowStart && endMinutes <= windowEnd;
      });

      if (!fitsWindow) {
        const windowDescriptions = matchingWindows.map((w) => `${w.start}-${w.end}`).join(', ');
        violations.push({
          kind: 'outside-window',
          message: `Requested time falls outside availability windows (${windowDescriptions}).`,
        });
      }
    }
  }

  // 4. Blackout
  if (availability.blackouts.length > 0) {
    const requestDateStr = new Date(request.start).toISOString().slice(0, 10);
    if (availability.blackouts.includes(requestDateStr)) {
      violations.push({ kind: 'blackout', message: `${requestDateStr} is a blackout date.` });
    }
  }

  // 5. Conflict
  for (const booking of existingBookings) {
    if (request.start < booking.end && booking.start < request.end) {
      violations.push({ kind: 'conflict', message: `Conflicts with existing booking ${booking.id}.` });
      break;
    }
  }

  return { available: violations.length === 0, violations };
}
