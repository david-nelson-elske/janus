/**
 * Demo server — boots the demo app and serves at localhost:3000.
 *
 * Usage: bun examples/dev-app/serve.ts
 *
 * Serves:
 * - API at /api/* (CRUD + lifecycle transitions)
 * - SSE at /api/events?subscribe=task,adr,...
 * - Pages at /* (SSR with Preact)
 */

import { clearRegistry } from '@janus/core';
import { createApp, apiSurface } from '@janus/http';
import { allDefinitions } from './entities';
import { allParticipations } from './participation';
import { allSubscriptions } from './subscriptions';
import { allBindings } from './bindings';

async function main() {
  clearRegistry();

  const surface = apiSurface({
    identity: {
      keys: {
        'demo-key': { id: 'demo-user', roles: ['admin'] },
      },
    },
  });

  const app = await createApp({
    declarations: [
      ...allDefinitions,
      ...allParticipations,
      ...allSubscriptions,
      ...allBindings,
    ],
    surfaces: [surface],
    store: { path: 'examples/dev-app/janus.db' },
  });

  const server = Bun.serve({
    port: 3000,
    hostname: '0.0.0.0',
    fetch: app.fetch,
  });

  console.log(`Janus demo server running at http://0.0.0.0:${server.port}`);
  console.log(`  Local:     http://localhost:${server.port}`);
  console.log(`  Tailscale: http://100.75.81.48:${server.port}`);
  console.log(`  API:       http://localhost:${server.port}/api/tasks`);
  console.log(`  Pages:     http://localhost:${server.port}/tasks`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await app.shutdown();
    server.stop();
    process.exit(0);
  });
}

main().catch(console.error);
