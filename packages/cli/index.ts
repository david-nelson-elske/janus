#!/usr/bin/env bun
/**
 * janus CLI — entry point.
 *
 * Boots the demo app and executes a command against it.
 */

import { boot } from '../dev/app';
import { parseArgs, executeCommand } from './commands';

async function main() {
  const parsed = parseArgs(process.argv);

  try {
    const app = parsed.command === 'help' ? undefined : await boot();
    const output = await executeCommand(parsed, app?.runtime, app?.registry);
    console.log(output);
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
