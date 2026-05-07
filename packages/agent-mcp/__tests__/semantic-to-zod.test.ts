import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { semanticToZodShape } from '..';
import { Str, Int, Float, Bool, Enum, Json, DateTime } from '@janus/vocabulary';

describe('semanticToZodShape', () => {
  test('Str() → string, optional by default', () => {
    const shape = semanticToZodShape({ name: Str() });
    const obj = z.object(shape);
    expect(obj.safeParse({}).success).toBe(true);
    expect(obj.safeParse({ name: 'hi' }).success).toBe(true);
    expect(obj.safeParse({ name: 5 }).success).toBe(false);
  });

  test('Str({ required: true }) → required string', () => {
    const shape = semanticToZodShape({ name: Str({ required: true }) });
    const obj = z.object(shape);
    expect(obj.safeParse({}).success).toBe(false);
    expect(obj.safeParse({ name: 'hi' }).success).toBe(true);
  });

  test('Int() → integer-only number', () => {
    const shape = semanticToZodShape({ n: Int({ required: true }) });
    const obj = z.object(shape);
    expect(obj.safeParse({ n: 5 }).success).toBe(true);
    expect(obj.safeParse({ n: 5.5 }).success).toBe(false);
    expect(obj.safeParse({ n: 'x' }).success).toBe(false);
  });

  test('Float() → number (no integer constraint)', () => {
    const shape = semanticToZodShape({ x: Float({ required: true }) });
    const obj = z.object(shape);
    expect(obj.safeParse({ x: 1.5 }).success).toBe(true);
    expect(obj.safeParse({ x: 5 }).success).toBe(true);
  });

  test('Bool() → boolean', () => {
    const shape = semanticToZodShape({ flag: Bool({ required: true }) });
    const obj = z.object(shape);
    expect(obj.safeParse({ flag: true }).success).toBe(true);
    expect(obj.safeParse({ flag: 'true' }).success).toBe(false);
  });

  test('Enum(...) → restricted string set', () => {
    const shape = semanticToZodShape({
      account: Enum(['personal', 'work', 'condo'], { required: true }),
    });
    const obj = z.object(shape);
    expect(obj.safeParse({ account: 'personal' }).success).toBe(true);
    expect(obj.safeParse({ account: 'unknown' }).success).toBe(false);
  });

  test('Json() → unknown (no type constraint)', () => {
    const shape = semanticToZodShape({ payload: Json() });
    const obj = z.object(shape);
    expect(obj.safeParse({}).success).toBe(true);
    expect(obj.safeParse({ payload: { anything: [1, 2] } }).success).toBe(true);
  });

  test('DateTime() → string', () => {
    const shape = semanticToZodShape({ when: DateTime({ required: true }) });
    const obj = z.object(shape);
    expect(obj.safeParse({ when: '2026-05-07T00:00:00Z' }).success).toBe(true);
    expect(obj.safeParse({ when: 5 }).success).toBe(false);
  });

  test('mixed required + optional fields', () => {
    const shape = semanticToZodShape({
      query: Str({ required: true }),
      pageSize: Int(),
      verbose: Bool(),
    });
    const obj = z.object(shape);
    expect(obj.safeParse({ query: 'q' }).success).toBe(true);
    expect(obj.safeParse({}).success).toBe(false);
    expect(obj.safeParse({ query: 'q', pageSize: 20, verbose: false }).success).toBe(true);
  });

  test('empty schema produces empty shape', () => {
    const shape = semanticToZodShape({});
    expect(Object.keys(shape).length).toBe(0);
  });
});
