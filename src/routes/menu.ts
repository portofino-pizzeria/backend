import type { FastifyInstance } from 'fastify';

import { loadMenu, toPublicMenu } from '../lib/menu-service.js';
import type { Menu } from '../types.js';

export async function menuRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/menu -> { categories, items, allergenLegend }
  //
  // Unavailable items are filtered out here and nowhere else: the owner's
  // editor reads the same loader with `includeUnavailable`, so the two views
  // resolve variants and allergen codes identically by construction.
  app.get('/api/menu', async (): Promise<Menu> => {
    return toPublicMenu(await loadMenu());
  });
}
