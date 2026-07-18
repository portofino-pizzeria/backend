import cors from '@fastify/cors';
import Fastify, { type FastifyError } from 'fastify';

import { config, stripeEnabled } from './config.js';
import { runMigrations } from './db/migrate.js';
import { seedMenu } from './db/seed.js';
import { HttpError } from './lib/http-errors.js';
import { kitchenRoutes } from './routes/kitchen.js';
import { menuRoutes } from './routes/menu.js';
import { orderRoutes } from './routes/orders.js';
import { paymentRoutes } from './routes/payments.js';

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  });

  // Turn our typed HttpError (and anything else) into the { error } JSON shape
  // the mobile app's api client reads.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: err.message ?? 'Internal error' });
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    stripe: stripeEnabled ? 'live-keys' : 'mock',
  }));

  await app.register(menuRoutes);
  await app.register(orderRoutes);
  await app.register(paymentRoutes);
  await app.register(kitchenRoutes);

  // Start serving immediately so the platform health check (/api/health, which
  // doesn't touch the DB) passes even while the database is still coming up.
  await app.listen({ port: config.port, host: '0.0.0.0' });

  // Then bring the schema up + seed, retrying while the DB becomes reachable —
  // a freshly-provisioned Aurora endpoint can take a bit to resolve/accept
  // connections. Idempotent, so safe on every boot.
  await initDatabase(app);
}

async function initDatabase(app: ReturnType<typeof Fastify>): Promise<void> {
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
