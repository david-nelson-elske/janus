#!/usr/bin/env bun
/**
 * Parity CLI — exit non-zero on translation key drift.
 *
 * Usage:
 *   bun packages/i18n/parity-cli.ts <resourcesDir>
 *   # or in app's package.json:
 *   "lang:check": "bun packages/i18n/parity-cli.ts ./lang"
 */

import { checkParity, formatParityReport } from './parity';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: parity-cli <resourcesDir>');
  process.exit(2);
}

const report = await checkParity(dir);
console.log(formatParityReport(report));
process.exit(report.ok ? 0 : 1);
