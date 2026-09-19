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

import { config, kitchenAuthMode, stripeEnabled } from './config.js';
import { HttpError } from './lib/http-errors.js';
import { readLegalStatus } from './lib/legal-status.js';
import { adminMenuRoutes } from './routes/admin-menu.js';
import { adminShopRoutes } from './routes/admin-shop.js';
import { kitchenRoutes } from './routes/kitchen.js';
import { menuRoutes } from './routes/menu.js';
import { orderRoutes } from './routes/orders.js';
import { paymentRoutes } from './routes/payments.js';
import { shopRoutes } from './routes/shop.js';

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

  // The deploy pipeline's only proof that the artifact it just pushed is the
  // one now serving traffic: `commit` is baked into the image at build time,
  // so a workflow can assert on it after a deploy. `'unknown'` when the image
  // was built without the build arg (see config.ts) — honest, never a crash.
  //
  // `kitchen` is the same idea for configuration rather than code: it reports
  // how the kitchen guard is armed (`token` | `auth-disabled` | `unconfigured`,
  // see `kitchenAuthMode`) so the deploy can refuse to call a deployment
  // verified while `/api/kitchen/*` is either open to the internet or dead.
  // It reveals nothing a single unauthenticated request would not.
  // `legal` is the same idea again, for the law rather than for code or
  // configuration: a German business app must carry a complete Impressum
  // (§ 5 DDG), and the facts are the owner's to supply. It is served from an
  // in-process cache and NEVER from a query — this route is App Runner's own
  // health check and answers before the database is reachable (see
  // lib/legal-status.ts). `legalMissing` names the gaps while there are any,
  // so the deploy can warn with something actionable in it.
  app.get('/api/health', async () => {
    const legal = readLegalStatus();
    return {
      status: 'ok',
      commit: config.commit,
      stripe: stripeEnabled ? 'live-keys' : 'mock',
      kitchen: kitchenAuthMode(),
      legal: legal.legal,
      ...(legal.legal === 'incomplete' ? { legalMissing: legal.missing } : {}),
    };
  });

  await app.register(menuRoutes);
  await app.register(shopRoutes);
  await app.register(orderRoutes);
  await app.register(paymentRoutes);
  await app.register(kitchenRoutes);
  await app.register(adminMenuRoutes);
  await app.register(adminShopRoutes);

  return app;
}
