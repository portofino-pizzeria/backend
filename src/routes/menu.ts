import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { db } from '../db/client.js';
import { menuItems } from '../db/schema.js';
import type { MenuCategory, MenuItem } from '../types.js';

export async function menuRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/menu -> { items: MenuItem[] }
  app.get('/api/menu', async () => {
    const rows = await db
      .select()
      .from(menuItems)
      .where(eq(menuItems.available, true))
      .orderBy(asc(menuItems.sortOrder));

    const items: MenuItem[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category as MenuCategory,
      price: r.price,
      imageUrl: r.imageUrl ?? undefined,
      vegetarian: r.vegetarian,
      spicy: r.spicy,
    }));

    return { items };
  });
}
