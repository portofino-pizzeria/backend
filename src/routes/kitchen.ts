import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { config } from '../config.js';
import { badRequest, unauthorized } from '../lib/http-errors.js';
import { secretsMatch } from '../lib/secrets.js';
import { listKitchenOrders, setOrderStatus } from '../lib/order-service.js';

/**
 * Shared-secret guard for the kitchen surface. **It fails CLOSED**, matching
 * `routes/admin-menu.ts`.
 *
 * This guard used to skip its check entirely when `KITCHEN_TOKEN` was unset,
 * on the reasoning that the kitchen dashboard is "a screen already behind the
 * counter". The screen is; the API is not. `GET /api/kitchen/orders` returns
 * every order's customer name, phone number and delivery address, so a
 * deployment that forgot to set the token served personal data to anyone who
 * asked — and since this repository is public, the shape of that request is
 * not a secret.
 *
 * Local dev and the test suite opt out explicitly with
 * `KITCHEN_AUTH_DISABLED=1`; see `config.kitchenAuthDisabled` for why it is an
 * opt-out rather than a `NODE_ENV` check.
 */
async function requireKitchenAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!config.kitchenToken) {
    if (config.kitchenAuthDisabled) return;
    throw unauthorized(
      'Kitchen access is not configured on this server (KITCHEN_TOKEN is not ' +
        'set). Requests are refused rather than served unauthenticated.',
    );
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !secretsMatch(token, config.kitchenToken)) {
    throw unauthorized('Invalid kitchen token.');
  }
}

const statusSchema = z.object({
  status: z.enum(['preparing', 'ready', 'cancelled']),
});

export async function kitchenRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireKitchenAuth);

  // GET /api/kitchen/orders?scope=active|all -> { orders }
  app.get<{ Querystring: { scope?: string } }>(
    '/api/kitchen/orders',
    async (req) => {
      const scope = req.query.scope === 'all' ? 'all' : 'active';
      const orders = await listKitchenOrders(scope);
      return { orders };
    },
  );

  // POST /api/kitchen/orders/:id/status  { status } -> { order }
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/kitchen/orders/:id/status',
    async (req) => {
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('status must be preparing, ready, or cancelled.');
      const order = await setOrderStatus(req.params.id, parsed.data.status);
      return { order };
    },
  );
}
