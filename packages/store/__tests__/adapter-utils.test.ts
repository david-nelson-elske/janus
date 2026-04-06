import { describe, expect, test } from 'bun:test';
import { Persistent, Singleton, Volatile } from '@janus/vocabulary';
import { hours } from '@janus/vocabulary';
import { useSoftDelete } from '..';
import type { AdapterMeta } from '..';
import { Str, Int } from '@janus/vocabulary';

function makeMeta(storage: ReturnType<typeof Persistent | typeof Singleton | typeof Volatile>): AdapterMeta {
  return {
    entity: 'test_entity',
    table: 'test_entity',
    schema: { name: Str(), count: Int() },
    storage,
  };
}

describe('useSoftDelete', () => {
  test('Persistent → true', () => {
    expect(useSoftDelete(makeMeta(Persistent()))).toBe(true);
  });

  test('Singleton → true', () => {
    expect(useSoftDelete(makeMeta(Singleton({ defaults: {} })))).toBe(true);
  });

  test('Volatile → false', () => {
    expect(useSoftDelete(makeMeta(Volatile({ retain: hours(24) })))).toBe(false);
  });
});
