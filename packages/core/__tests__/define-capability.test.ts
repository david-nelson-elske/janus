import { describe, expect, test } from 'bun:test';
import { defineCapability } from '..';
import type { CapabilityContext } from '..';
import { Str, Int, Enum } from '@janus/vocabulary';

const noopHandler = async (_input: unknown, _ctx: CapabilityContext): Promise<unknown> => {
  return { ok: true };
};

describe('defineCapability()', () => {
  test('returns frozen CapabilityResult with kind: capability', () => {
    const result = defineCapability({
      name: 'drive__search',
      description: 'Search Drive',
      inputSchema: { query: Str({ required: true }) },
      handler: noopHandler,
    });
    expect(result.kind).toBe('capability');
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('record is deeply frozen', () => {
    const result = defineCapability({
      name: 'drive__search',
      description: 'Search Drive',
      inputSchema: { query: Str({ required: true }) },
      tags: ['drive', 'google'],
      handler: noopHandler,
    });
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.inputSchema)).toBe(true);
    expect(Object.isFrozen(result.record.tags)).toBe(true);
  });

  test('preserves all config fields on the record', () => {
    const handler = noopHandler;
    const result = defineCapability({
      name: 'drive__search',
      description: 'Search Drive',
      longDescription: 'Native Drive query syntax',
      inputSchema: {
        query: Str({ required: true }),
        accountLabel: Enum(['personal', 'work', 'condo']),
        pageSize: Int(),
      },
      outputSchema: { ok: Str() },
      observe: true,
      tags: ['drive'],
      handler,
    });
    expect(result.record.name).toBe('drive__search');
    expect(result.record.description).toBe('Search Drive');
    expect(result.record.longDescription).toBe('Native Drive query syntax');
    expect(result.record.inputSchema.query).toBeDefined();
    expect(result.record.outputSchema?.ok).toBeDefined();
    expect(result.record.observe).toBe(true);
    expect(result.record.tags).toEqual(['drive']);
    expect(result.record.handler).toBe(handler);
  });

  test('handler reference is preserved exactly', () => {
    const handler = async (input: unknown) => ({ echoed: input });
    const result = defineCapability({
      name: 'echo__call',
      description: 'echo',
      inputSchema: { msg: Str() },
      handler,
    });
    expect(result.record.handler).toBe(handler);
  });

  test('multiple defineCapability() calls produce independent records', () => {
    const a = defineCapability({
      name: 'drive__search',
      description: 'a',
      inputSchema: { q: Str() },
      handler: noopHandler,
    });
    const b = defineCapability({
      name: 'web__fetch',
      description: 'b',
      inputSchema: { url: Str() },
      handler: noopHandler,
    });
    expect(a.record.name).toBe('drive__search');
    expect(b.record.name).toBe('web__fetch');
    expect(a.record).not.toBe(b.record);
  });

  // ── Validation ──────────────────────────────────────────────

  test('rejects empty name', () => {
    expect(() =>
      defineCapability({
        name: '',
        description: 'x',
        inputSchema: { q: Str() },
        handler: noopHandler,
      }),
    ).toThrow(/must not be empty/);
  });

  test('rejects name without namespace__verb shape', () => {
    expect(() =>
      defineCapability({
        name: 'drive_search',
        description: 'x',
        inputSchema: { q: Str() },
        handler: noopHandler,
      }),
    ).toThrow(/must match/);
  });

  test('rejects name with uppercase', () => {
    expect(() =>
      defineCapability({
        name: 'Drive__Search',
        description: 'x',
        inputSchema: { q: Str() },
        handler: noopHandler,
      }),
    ).toThrow(/must match/);
  });

  test('accepts namespace__verb with multi-word segments', () => {
    expect(() =>
      defineCapability({
        name: 'drive_files__edit_copy',
        description: 'x',
        inputSchema: { id: Str() },
        handler: noopHandler,
      }),
    ).not.toThrow();
  });

  test('rejects name longer than max', () => {
    const longName = 'a'.repeat(40) + '__' + 'b'.repeat(40); // 82 chars
    expect(() =>
      defineCapability({
        name: longName,
        description: 'x',
        inputSchema: { q: Str() },
        handler: noopHandler,
      }),
    ).toThrow(/at most/);
  });

  test('rejects missing description', () => {
    expect(() =>
      defineCapability({
        name: 'drive__search',
        description: '',
        inputSchema: { q: Str() },
        handler: noopHandler,
      }),
    ).toThrow(/description/);
  });

  test('rejects missing inputSchema', () => {
    expect(() =>
      defineCapability({
        name: 'drive__search',
        description: 'x',
        // @ts-expect-error testing runtime guard
        inputSchema: undefined,
        handler: noopHandler,
      }),
    ).toThrow(/inputSchema/);
  });

  test('rejects non-function handler', () => {
    expect(() =>
      defineCapability({
        name: 'drive__search',
        description: 'x',
        inputSchema: { q: Str() },
        // @ts-expect-error testing runtime guard
        handler: 'not-a-function',
      }),
    ).toThrow(/handler function/);
  });

  test('rejects invalid input field name', () => {
    expect(() =>
      defineCapability({
        name: 'drive__search',
        description: 'x',
        inputSchema: { '123bad': Str() },
        handler: noopHandler,
      }),
    ).toThrow(/inputSchema field name/);
  });
});
