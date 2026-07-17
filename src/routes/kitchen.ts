import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { config } from '../config.js';
import { badRequest, unauthorized } from '../lib/http-errors.js';
import { listKitchenOrders, setOrderStatus } from '../lib/order-service.js';

// Simple shared-secret guard. When KITCHEN_TOKEN is unset (local dev) the check
// is skipped. In deployed environments set it and the dashboard sends it as a
// Bearer token.
async function requireKitchenAuth(req: FastifyRequest, _reply: FastifyReply) {
  if (!config.kitchenToken) return;
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== config.kitchenToken) throw unauthorized('Invalid kitchen token.');
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
