#!/usr/bin/env bun
/**
 * janus CLI — entry point for the dev-app.
 *
 * Other apps can create their own entry point using runCLI() from ./commands.
 */

import { boot } from '../../examples/dev-app/app';
import { runCLI } from './commands';

runCLI({
  boot: async () => {
    const app = await boot();
    return { runtime: app.runtime, registry: app.registry };
  },
  name: 'janus',
});
