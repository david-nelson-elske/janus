/**
 * Rate limit counter store — in-memory sliding window (ADR 05).
 *
 * Tracks per-key request counts within a time window. Keys auto-expire
 * when the window elapses. No external dependencies for single-server use.
 */

export interface RateLimitStore {
  /**
   * Check and increment a counter. Returns the current count within the window.
   * If count exceeds `max`, returns the count without incrementing.
   */
  check(key: string, max: number, windowMs: number): { count: number; blocked: boolean; retryAfterMs?: number };

  /** Read the current count for a key without incrementing. */
  peek(key: string, windowMs: number): number;

  /** Clear all counters (for testing). */
  clear(): void;
}

interface Entry {
  count: number;
  windowStart: number;
}

/**
 * Create an in-memory rate limit store with sliding window counters.
 * Counters auto-reset when the window elapses.
 */
export function createRateLimitStore(): RateLimitStore {
  const counters = new Map<string, Entry>();

  function getEntry(key: string, windowMs: number, now: number): Entry {
    const existing = counters.get(key);
    if (existing && now - existing.windowStart < windowMs) {
      return existing;
    }
    // Window expired or no entry — start fresh
    const entry: Entry = { count: 0, windowStart: now };
    counters.set(key, entry);
    return entry;
  }

  return {
    check(key, max, windowMs) {
      const now = Date.now();
      const entry = getEntry(key, windowMs, now);

      if (entry.count >= max) {
        const retryAfterMs = windowMs - (now - entry.windowStart);
        return { count: entry.count, blocked: true, retryAfterMs };
      }

      entry.count++;
      return { count: entry.count, blocked: false };
    },

    peek(key, windowMs) {
      const now = Date.now();
      const existing = counters.get(key);
      if (!existing || now - existing.windowStart >= windowMs) return 0;
      return existing.count;
    },

    clear() {
      counters.clear();
    },
  };
}
