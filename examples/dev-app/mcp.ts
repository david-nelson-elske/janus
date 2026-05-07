#!/usr/bin/env bun
/**
 * MCP server entrypoint for the dev-app.
 *
 * Boots the dev-app's registry and runtime, then connects an MCP server
 * on stdio. Capabilities (system__time, web__fetch, framework__describe)
 * become callable from any MCP client — including Claude Code Remote
 * Control.
 *
 * Usage:
 *   bun examples/dev-app/mcp.ts
 *
 * Wire into Claude Code:
 *   {
 *     "mcpServers": {
 *       "janus-dev": {
 *         "command": "bun",
 *         "args": ["examples/dev-app/mcp.ts"]
 *       }
 *     }
 *   }
 */

import { boot } from './app';
import { agentSurface } from '@janus/agent';
import { serveCapabilitiesOnStdio } from '@janus/agent-mcp';

async function main() {
  const surface = agentSurface();
  const app = await boot({ initiators: [surface.initiator] });

  // Errors and lifecycle messages must go to stderr — stdout is the MCP wire.
  console.error(
    `[janus-dev MCP] ${app.registry.capabilities.size} capabilities ready`,
  );

  await serveCapabilitiesOnStdio({
    registry: app.registry,
    runtime: app.runtime,
    initiator: surface.initiator.name,
    serverInfo: { name: 'janus-dev', version: '0.0.1' },
  });
}

main().catch((err) => {
  console.error('[janus-dev MCP] fatal:', err);
  process.exit(1);
});
