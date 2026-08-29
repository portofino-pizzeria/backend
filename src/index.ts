import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { seedMenu } from './db/seed.js';

async function main() {
  const app = await buildApp();

  // Start serving immediately so the platform health check (/api/health, which
  // doesn't touch the DB) passes even while the database is still coming up.
  await app.listen({ port: config.port, host: '0.0.0.0' });

  // Then bring the schema up + seed, retrying while the DB becomes reachable —
  // a freshly-provisioned Aurora endpoint can take a bit to resolve/accept
  // connections. Idempotent, so safe on every boot.
  await initDatabase(app);
}

async function initDatabase(app: FastifyInstance): Promise<void> {
  const attempts = 20;
  const delayMs = 6000;
  for (let i = 1; i <= attempts; i++) {
    try {
      await runMigrations();
      const seeded = await seedMenu();
      app.log.info(`Database ready (${seeded} menu items).`);
      return;
    } catch (err) {
      app.log.warn(
        `DB init attempt ${i}/${attempts} failed: ${(err as Error).message}`,
      );
      if (i === attempts) {
        app.log.error('Database init failed after all retries; serving anyway.');
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
