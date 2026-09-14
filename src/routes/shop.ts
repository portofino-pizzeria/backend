import type { FastifyInstance } from 'fastify';

import { now } from '../lib/clock.js';
import { DELIVERY_UNTIL, HOURS_DISPLAY, SHOP, shopStatus } from '../lib/shop.js';

export async function shopRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/shop -> the address, phone, printed hours, and whether pickup and
  // delivery orders are taken right now. The app renders this status rather
  // than computing its own, so the diner sees the same answer the order route
  // will enforce.
  app.get('/api/shop', async () => ({
    ...SHOP,
    hours: HOURS_DISPLAY,
    deliveryUntil: DELIVERY_UNTIL,
    status: shopStatus(now()),
  }));
}
