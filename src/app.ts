// Builds the Fastify instance: CORS, the error handler that turns our typed
// HttpError into the `{ error }` JSON body the mobile app reads, and every
// route plugin.
//
// This is deliberately separate from `index.ts`. `index.ts` owns the *process*
// (listen, migrate, seed, retry); this owns the *application*. Tests build the
// same instance and drive it with `app.inject()`, so they exercise the real
// error handler and the real route registration order rather than a copy of
// them that could drift.

import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { config, stripeEnabled } from './config.js';
import { HttpError } from './lib/http-errors.js';
import { adminMenuRoutes } from './routes/admin-menu.js';
import { kitchenRoutes } from './routes/kitchen.js';
import { menuRoutes } from './routes/menu.js';
import { orderRoutes } from './routes/orders.js';
import { paymentRoutes } from './routes/payments.js';

export interface BuildAppOptions {
  /** Request logging. On in the server process, off under test. */
  logger?: boolean;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  });

  // Turn our typed HttpError (and anything else) into the { error } JSON shape
  // the mobile app's api client reads.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status =
      err instanceof HttpError ? err.statusCode : (err.statusCode ?? 500);
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
  await app.register(adminMenuRoutes);

  return app;
}
