#!/usr/bin/env bun
/**
 * Interactive chat — boots the demo app with an agent surface and starts
 * a Claude-powered conversation loop against the entity graph.
 *
 * Usage:
 *   bun run janus:chat
 *   ANTHROPIC_API_KEY=sk-... bun examples/dev-app/chat.ts
 */

import * as readline from 'node:readline';
import { boot } from './app';
import { agentSurface, createAgentLoop } from '@janus/agent';
import type { AgentResponse } from '@janus/agent';

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // Boot with agent surface compiled in
  const surface = agentSurface();
  const app = await boot({ initiators: [surface.initiator] });

  console.log('Janus agent chat — type your message, or /quit to exit');
  console.log(`Discovered ${app.registry.graphNodes.size} entities\n`);

  const loop = createAgentLoop({
    runtime: app.runtime,
    registry: app.registry,
    initiator: surface.initiator.name,
    onToolCall(entity: string, operation: string, input: unknown) {
      console.log(`  → ${entity}:${operation}`, JSON.stringify(input));
    },
    onToolResult(entity: string, operation: string, result: AgentResponse) {
      console.log(`  ← ${entity}:${operation} [${result.ok ? 'ok' : 'error'}]`);
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nyou> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('Goodbye.');
      process.exit(0);
    }
    if (trimmed === '/reset') {
      loop.reset();
      console.log('Conversation reset.');
      rl.prompt();
      return;
    }
    if (trimmed === '/tools') {
      for (const t of loop.tools) {
        console.log(`  ${t.name}: ${t.description}`);
      }
      rl.prompt();
      return;
    }

    try {
      const response = await loop.chat(trimmed);
      console.log(`\nassistant> ${response}`);
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye.');
    process.exit(0);
  });
}

main();
