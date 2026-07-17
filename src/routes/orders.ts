import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { badRequest, notFound } from '../lib/http-errors.js';
import { createOrder, getOrder } from '../lib/order-service.js';

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: z.string().min(1),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .min(1),
  customer: z
    .object({
      name: z.string().max(200).optional(),
      phone: z.string().max(50).optional(),
      address: z.string().max(500).optional(),
      notes: z.string().max(1000).optional(),
    })
    .optional(),
});

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/orders -> { order }
  app.post('/api/orders', async (req) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid order.');
    }
    const order = await createOrder(parsed.data);
    return { order };
  });

  // GET /api/orders/:id -> { order }
  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req) => {
    const order = await getOrder(req.params.id);
    if (!order) throw notFound('Order not found.');
    return { order };
  });
}
