/**
 * Translation parity check — fails when languages have key drift.
 *
 * For each `<resourcesDir>/<lang>.json`, walks the nested key tree, then
 * reports any keys that are present in *some* lang and missing in others.
 * Plural variants (`key_one`, `key_other`, ...) are normalized to their root
 * key for comparison so French's extra plural forms don't produce false
 * positives.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface ParityReport {
  /** True when every lang has the same key set. */
  readonly ok: boolean;
  /** lang → keys present elsewhere but missing in this lang. */
  readonly missing: Readonly<Record<string, readonly string[]>>;
  /** All lang codes inspected. */
  readonly langs: readonly string[];
}

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

export async function checkParity(resourcesDir: string): Promise<ParityReport> {
  const entries = await fs.readdir(resourcesDir);
  const jsonFiles = entries.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    return { ok: true, missing: {}, langs: [] };
  }

  const keysByLang: Record<string, Set<string>> = {};
  for (const file of jsonFiles) {
    const lang = file.replace(/\.json$/, '');
    const raw = await fs.readFile(join(resourcesDir, file), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    keysByLang[lang] = collectKeys(data);
  }

  const langs = Object.keys(keysByLang).sort();
  const union = new Set<string>();
  for (const set of Object.values(keysByLang)) for (const key of set) union.add(key);

  const missing: Record<string, string[]> = {};
  for (const lang of langs) {
    const gaps: string[] = [];
    for (const key of union) {
      if (!keysByLang[lang].has(key)) gaps.push(key);
    }
    if (gaps.length > 0) missing[lang] = gaps.sort();
  }

  return { ok: Object.keys(missing).length === 0, missing, langs };
}

function collectKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = rawKey.replace(PLURAL_SUFFIX_RE, '');
    const full = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of collectKeys(value as Record<string, unknown>, full)) {
        out.add(nested);
      }
    } else {
      out.add(full);
    }
  }
  return out;
}

export function formatParityReport(report: ParityReport): string {
  if (report.ok) {
    return `Parity OK — ${report.langs.length} language(s): ${report.langs.join(', ')}`;
  }
  const lines = [`Translation parity FAILED across ${report.langs.join(', ')}:`];
  for (const [lang, keys] of Object.entries(report.missing)) {
    lines.push(`  ${lang} is missing ${keys.length} key(s):`);
    for (const key of keys) lines.push(`    - ${key}`);
  }
  return lines.join('\n');
}
