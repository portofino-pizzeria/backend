// Builds the Fastify instance: CORS, the error handler that turns our typed
// HttpError into the `{ error }` JSON body the mobile app reads, and every
// route plugin.
//
// This is deliberately separate from `index.ts`. `index.ts` owns the *process*
// (listen, migrate, seed, retry); this owns the *application*. Tests build the
// same instance and drive it with `app.inject()`, so they exercise the real
// error handler and the real route registration order rather than a copy of
// them that could drift.

import type { Writable } from 'node:stream';

import cors from '@fastify/cors';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';

import { config, kitchenAuthMode, stripeEnabled } from './config.js';
import { HttpError } from './lib/http-errors.js';
import { adminMenuRoutes } from './routes/admin-menu.js';
import { kitchenRoutes } from './routes/kitchen.js';
import { menuRoutes } from './routes/menu.js';
import { orderRoutes } from './routes/orders.js';
import { paymentRoutes } from './routes/payments.js';
import { shopRoutes } from './routes/shop.js';

export interface BuildAppOptions {
  /** Request logging. On in the server process, off under test. */
  logger?: boolean;
  /**
   * Where the log goes. Only meaningful with `logger: true`, and only used by
   * the tests that assert on what is written — see `test/logging.test.ts`.
   */
  logStream?: Writable;
}

/**
 * Fastify's own `req` serializer, MINUS the client IP (decision D4).
 *
 * Fastify logs `{ req: request }` at request RECEIPT
 * (`fastify/lib/log-controller.js`), and its serializer
 * (`fastify/lib/logger-pino.js`) returns `remoteAddress: req.ip` and
 * `remotePort`. Those lines go to CloudWatch, where — until Phase 3's infra
 * half — nothing expires them. "We keep your IP address forever" is not a
 * sentence anyone wants to publish.
 *
 * It has to be done HERE, by replacing the serializer, rather than by
 * redacting successful requests:
 *
 * - the `'incoming request'` line is emitted before any status code exists, so
 *   neither the serializer nor pino's `redact` can see one;
 * - the completion line carries only `{ res: { statusCode } }`;
 * - `disableRequestLogging` takes a function of `req`, also status-free, and
 *   is deprecated in Fastify 5.10 and removed in 6.
 *
 * So the IP never reaches the hot path at all, and the `onResponse` hook below
 * puts it back for the requests where it is actually useful — the failing ones.
 * This deletes a field rather than adding a code path on the successful side.
 */
function requestWithoutClientIp(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: req.url,
    version: req.headers?.['accept-version'],
    host: req.host,
  };
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const loggingOn = options.logger ?? true;
  const app = Fastify({
    logger: loggingOn
      ? {
          serializers: { req: requestWithoutClientIp },
          ...(options.logStream ? { stream: options.logStream } : {}),
        }
      : false,
  });

  /**
   * The client IP, on failures only (decision D4).
   *
   * D4 sets the App Runner log groups to 14 days precisely because the IP is
   * gone from every successful request, so what those 14 days mostly hold is
   * errors — which is where an IP earns its keep: a burst of 401s against the
   * kitchen token, or a 400 loop from one address, is unreadable without it.
   *
   * `onResponse` is the first hook with a status code in hand.
   */
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode < 400) return;
    request.log.warn(
      { ip: request.ip, statusCode: reply.statusCode, url: request.url },
      'request failed',
    );
  });

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
  app.get('/api/health', async () => ({
    status: 'ok',
    commit: config.commit,
    stripe: stripeEnabled ? 'live-keys' : 'mock',
    kitchen: kitchenAuthMode(),
  }));

  await app.register(menuRoutes);
  await app.register(shopRoutes);
  await app.register(orderRoutes);
  await app.register(paymentRoutes);
  await app.register(kitchenRoutes);
  await app.register(adminMenuRoutes);

  return app;
}
