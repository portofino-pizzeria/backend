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

  // Bring the schema up to date and ensure the menu exists. Safe to run on every
  // boot (migrations + seed are both idempotent).
  await runMigrations();
  const seeded = await seedMenu();
  app.log.info(`Menu ready (${seeded} items).`);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
