/**
 * Community Association server — boots the app and serves at localhost:3000.
 *
 * Usage: bun examples/community-association/serve.ts
 */
import { createApp } from '@janus/http';
import { allDefinitions } from './domain/entities';
import { allParticipations } from './domain/participation';
import { allSubscriptions, newsConnectorDeclarations } from './domain/subscriptions';
import { allConnectorDeclarations } from './connectors';
import { mountRoutes } from './routes';
import { seed } from './seed';
import { config } from './config';

async function main() {
  const app = await createApp({
    declarations: [
      ...allDefinitions,
      ...allParticipations,
      ...allSubscriptions,
      ...allConnectorDeclarations,
      ...newsConnectorDeclarations,
    ],
    http: { basePath: '/api' },
    apiKeys: {
      admin: { id: 'admin', roles: ['admin'] },
      system: { id: 'system', roles: ['system'] },
      member: { id: 'member', roles: ['member'] },
    },
    store: { path: config.database },
  });

  // Seed demo data
  await seed(app);

  // Mount custom routes on top of framework
  const hono = mountRoutes(app);

  const port = parseInt(process.env.PORT || '3001');
  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch: hono.fetch,
  });

  console.log(`\n${config.name} server running at http://localhost:${server.port}`);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await app.shutdown();
    server.stop();
    process.exit(0);
  });
}

main().catch(console.error);
