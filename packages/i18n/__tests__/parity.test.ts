/**
 * Parity check tests — drift detection across language files.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkParity, formatParityReport } from '../parity';

function tmpDir(label: string): string {
  const dir = join(tmpdir(), `janus-parity-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('checkParity', () => {
  test('passes when key trees match', async () => {
    const dir = tmpDir('match');
    writeFileSync(join(dir, 'en.json'), JSON.stringify({ a: 1, b: { c: 2 } }));
    writeFileSync(join(dir, 'fr.json'), JSON.stringify({ a: 1, b: { c: 2 } }));
    const report = await checkParity(dir);
    expect(report.ok).toBe(true);
    expect(report.langs).toEqual(['en', 'fr']);
    rmSync(dir, { recursive: true });
  });

  test('reports missing keys per lang', async () => {
    const dir = tmpDir('drift');
    writeFileSync(
      join(dir, 'en.json'),
      JSON.stringify({ a: 1, b: { c: 2, d: 3 }, e: 4 }),
    );
    writeFileSync(join(dir, 'fr.json'), JSON.stringify({ a: 1, b: { c: 2 } }));
    const report = await checkParity(dir);
    expect(report.ok).toBe(false);
    expect(report.missing.fr).toEqual(['b.d', 'e']);
    expect(report.missing.en).toBeUndefined();
    rmSync(dir, { recursive: true });
  });

  test('normalizes plural suffixes (French has no false positives for extra forms)', async () => {
    const dir = tmpDir('plural');
    writeFileSync(
      join(dir, 'en.json'),
      JSON.stringify({ count_one: '{{count}} thing', count_other: '{{count}} things' }),
    );
    writeFileSync(
      join(dir, 'fr.json'),
      JSON.stringify({
        count_one: '{{count}} chose',
        count_many: '{{count}} choses',
        count_other: '{{count}} choses',
      }),
    );
    const report = await checkParity(dir);
    expect(report.ok).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test('formatParityReport summarizes drift', () => {
    const txt = formatParityReport({
      ok: false,
      langs: ['en', 'fr'],
      missing: { fr: ['hero.slogan'] },
    });
    expect(txt).toContain('FAILED');
    expect(txt).toContain('hero.slogan');
  });

  test('empty dir yields ok=true', async () => {
    const dir = tmpDir('empty');
    const report = await checkParity(dir);
    expect(report.ok).toBe(true);
    expect(report.langs).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});
