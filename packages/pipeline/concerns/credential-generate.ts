/**
 * credential-generate — Auto-generate Token and QrCode field values on create.
 *
 * Order 30 (after schema-validate @ 25, before store-create @ 35).
 * Scans entity schema for token/qrcode fields and generates cryptographically
 * random values for any that are empty. Skips fields that already have a value
 * (allowing manual override).
 *
 * Token: machine-facing, 62-char alphabet (A-Z, a-z, 0-9), configurable prefix/length.
 * QrCode: human-facing, 32-char alphabet (excludes I, O, 0, 1 for readability),
 *         configurable length and format (alphanumeric/numeric).
 */

import { isSemanticField } from '@janus/vocabulary';
import type { TokenHints, QrCodeHints } from '@janus/vocabulary';
import type { ExecutionHandler } from '@janus/core';

// ── Character sets ──────────────────────────────────────────────

/** Machine-facing: full alphanumeric (62 chars). */
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Human-facing: excludes I, O, 0, 1 to avoid visual ambiguity (32 chars). */
const QRCODE_CHARS_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Numeric-only for codes that must be all digits (10 chars). */
const QRCODE_CHARS_NUMERIC = '0123456789';

// ── Generation ──────────────────────────────────────────────────

export function generateToken(length: number, prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let token = '';
  for (const b of bytes) {
    token += TOKEN_CHARS[b % TOKEN_CHARS.length];
  }
  return `${prefix}${token}`;
}

export function generateQrCode(length: number, format: 'alphanumeric' | 'numeric'): string {
  const chars = format === 'numeric' ? QRCODE_CHARS_NUMERIC : QRCODE_CHARS_ALPHA;
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let code = '';
  for (const b of bytes) {
    code += chars[b % chars.length];
  }
  return code;
}

// ── Concern handler ─────────────────────────────────────────────

export const credentialGenerate: ExecutionHandler = async (ctx) => {
  if (ctx.operation !== 'create') return;

  const parsed = ctx.parsed;
  if (!parsed || typeof parsed !== 'object') return;

  const entity = ctx.registry.entity(ctx.entity);
  if (!entity) return;

  for (const [field, fieldDef] of Object.entries(entity.schema)) {
    if (!isSemanticField(fieldDef)) continue;

    if (fieldDef.kind === 'token') {
      // Skip if already provided
      if (field in parsed && parsed[field]) continue;
      const hints = (fieldDef.hints ?? {}) as TokenHints;
      parsed[field] = generateToken(hints.length ?? 32, hints.prefix ?? '');

      // Compute expiry if configured
      if (hints.expires) {
        const companionField = `_${field}ExpiresAt`;
        if (companionField in entity.schema) {
          const expiryMs = parseDuration(hints.expires);
          parsed[companionField] = new Date(Date.now() + expiryMs).toISOString();
        }
      }
    }

    if (fieldDef.kind === 'qrcode') {
      // Skip if already provided
      if (field in parsed && parsed[field]) continue;
      const hints = (fieldDef.hints ?? {}) as QrCodeHints;
      parsed[field] = generateQrCode(hints.length ?? 12, hints.format ?? 'alphanumeric');
    }
  }
};

// ── Duration parsing ────────────────────────────────────────────

const DURATION_UNITS: Record<string, number> = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

const DURATION_RE = /(\d+)(w|d|h|m|s)/g;

/** Parse duration shorthand ('24h', '7d', '1h30m') to milliseconds. */
export function parseDuration(value: string | number): number {
  if (typeof value === 'number') return value;
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(DURATION_RE)) {
    total += Number(match[1]) * DURATION_UNITS[match[2]];
    matched = true;
  }
  if (!matched) {
    throw new Error(`Invalid duration: '${value}'. Expected format like '24h', '7d', '1h30m'.`);
  }
  return total;
}
