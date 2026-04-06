/**
 * Unit tests for calculateBackoff — retry delay calculation.
 *
 * Exercises: fixed backoff, exponential backoff, and no-config fallback.
 */

import { describe, expect, test } from 'bun:test';
import { calculateBackoff } from '..';
import type { RetryConfig } from '@janus/core';

describe('calculateBackoff()', () => {
  test('fixed backoff returns initialDelay regardless of attempt', () => {
    const config: RetryConfig = { max: 3, backoff: 'fixed', initialDelay: 500 };

    expect(calculateBackoff(config, 1)).toBe(500);
    expect(calculateBackoff(config, 2)).toBe(500);
    expect(calculateBackoff(config, 3)).toBe(500);
    expect(calculateBackoff(config, 10)).toBe(500);
  });

  test('exponential backoff: attempt 1 = initialDelay, attempt 2 = 2x, attempt 3 = 4x', () => {
    const config: RetryConfig = { max: 5, backoff: 'exponential', initialDelay: 1000 };

    expect(calculateBackoff(config, 1)).toBe(1000);   // 1000 * 2^0
    expect(calculateBackoff(config, 2)).toBe(2000);   // 1000 * 2^1
    expect(calculateBackoff(config, 3)).toBe(4000);   // 1000 * 2^2
    expect(calculateBackoff(config, 4)).toBe(8000);   // 1000 * 2^3
    expect(calculateBackoff(config, 5)).toBe(16000);  // 1000 * 2^4
  });

  test('no retry config: fallback = 100 * 5^(attempt-1)', () => {
    // attempt 1 = 100ms
    expect(calculateBackoff(undefined, 1)).toBe(100);
    // attempt 2 = 500ms
    expect(calculateBackoff(undefined, 2)).toBe(500);
    // attempt 3 = 2500ms
    expect(calculateBackoff(undefined, 3)).toBe(2500);
  });
});
