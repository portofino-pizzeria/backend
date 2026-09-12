// The owner's menu editor — `/api/admin/menu/*`.
//
// Its own namespace and its own credential, deliberately not the kitchen's
// (design decision D5). Every body is validated with zod at the door and again,
// against the database, inside the transaction that writes it — see
// lib/menu-admin-service.ts for the four safety properties this surface has to
// hold.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { config } from '../config.js';
import { badRequest, unauthorized } from '../lib/http-errors.js';
import { secretsMatch } from '../lib/secrets.js';
import {
  createCategory,
  createMenuItem,
  deleteAllergen,
  deleteCategory,
  deleteMenuItem,
  loadAdminMenu,
  reorderCategories,
  setMenuItemAvailability,
  updateCategory,
  updateMenuItem,
  upsertAllergen,
} from '../lib/menu-admin-service.js';

/**
 * The owner guard. **It fails CLOSED.**
 *
 * Decision D5 gave this surface its own credential and its own namespace: it
 * writes the allergens and prices a diner reads, so an unset `OWNER_MENU_TOKEN`
 * refuses every admin request instead of opening the editor to the whole
 * internet — a misconfigured deployment loses the editor, never the menu.
 *
 * When D5 was taken, the kitchen guard (`routes/kitchen.ts`) was the contrast:
 * it skipped its check entirely when `KITCHEN_TOKEN` was unset. It no longer
 * does — it fails closed the same way, and shares `secretsMatch` — so the two
 * guards now differ only in WHICH secret they check, which is what D5 was
 * actually about.
 */
async function requireOwnerAuth(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!config.ownerMenuToken) {
    throw unauthorized(
      'Der Speisekarten-Editor ist auf diesem Server nicht freigeschaltet ' +
        '(OWNER_MENU_TOKEN ist nicht gesetzt). Änderungen an der Speisekarte werden ' +
        'abgelehnt.',
    );
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !secretsMatch(token, config.ownerMenuToken)) {
    throw unauthorized('Ungültiges Kennwort für den Speisekarten-Editor.');
  }
}

// --- Body schemas ----------------------------------------------------------

const priceCents = z
  .number({
    required_error: 'Jede Variante braucht einen Preis in Cent.',
    invalid_type_error: 'Der Preis muss eine Zahl in Cent sein (z. B. 790 für 7,90 €).',
  })
  .int('Der Preis muss eine ganze Zahl in Cent sein (z. B. 790 für 7,90 €).')
  .positive('Der Preis muss größer als 0 sein.');

const variantSchema = z.object({
  id: z.string().max(120).optional(),
  label: z.string({ required_error: 'Jede Variante braucht eine Bezeichnung.' }).max(120),
  sortOrder: z.number().int().optional(),
  priceCents,
});

const allergenCodesSchema = z.array(z.string().max(8)).max(40);

const createItemSchema = z.object({
  id: z.string().max(120).optional(),
  number: z.string().max(16).nullable().optional(),
  name: z.string({ required_error: 'Das Gericht braucht einen Namen.' }).max(200),
  nameEn: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).optional(),
  descriptionEn: z.string().max(2000).nullable().optional(),
  categoryId: z
    .string({ required_error: 'Jedes Gericht braucht eine Kategorie.' })
    .min(1, 'Jedes Gericht braucht eine Kategorie.')
    .max(120),
  allergenCodes: allergenCodesSchema.optional(),
  confirmNoAllergens: z.boolean().optional(),
  imageUrl: z.string().max(500).nullable().optional(),
  available: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  // Defaults to an empty list so "an item with no priced size" is refused by
  // the availability rule below rather than by a missing-field error.
  variants: z.array(variantSchema).max(20).default([]),
});

const updateItemSchema = z.object({
  number: z.string().max(16).nullable().optional(),
  name: z.string().max(200).optional(),
  nameEn: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).optional(),
  descriptionEn: z.string().max(2000).nullable().optional(),
  categoryId: z.string().min(1).max(120).optional(),
  allergenCodes: allergenCodesSchema.optional(),
  confirmNoAllergens: z.boolean().optional(),
  imageUrl: z.string().max(500).nullable().optional(),
  available: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  variants: z.array(variantSchema).max(20).optional(),
});

const availabilitySchema = z.object({
  available: z.boolean({
    required_error: 'Bitte angeben, ob das Gericht verfügbar ist (available: true/false).',
  }),
});

const createCategorySchema = z.object({
  /** Empty derives the slug from the German label. */
  id: z.string().max(120).default(''),
  label: z.string({ required_error: 'Die Kategorie braucht einen Namen.' }).max(200),
  labelEn: z.string().max(200).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const updateCategorySchema = z.object({
  label: z.string().max(200).optional(),
  labelEn: z.string().max(200).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const reorderCategoriesSchema = z.object({
  ids: z
    .array(z.string().min(1).max(120), {
      required_error: 'Bitte die Kategorien in der gewünschten Reihenfolge senden (ids).',
    })
    .min(1, 'Bitte die Kategorien in der gewünschten Reihenfolge senden (ids).'),
});

const allergenSchema = z.object({
  code: z.string({ required_error: 'Der Allergen-Code fehlt.' }).max(8),
  labelDe: z
    .string({ required_error: 'Die deutsche Bezeichnung fehlt.' })
    .max(200),
  labelEn: z.string().max(200).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

/** Parse a body, turning the first zod complaint into the `{ error }` shape the
 *  editor renders. */
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    const message = issue?.message ?? 'Ungültige Eingabe.';
    throw badRequest(path ? `${message} (${path})` : message);
  }
  return result.data;
}

// --- Routes ----------------------------------------------------------------

export async function adminMenuRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireOwnerAuth);

  // GET /api/admin/menu -> { categories, items, allergenLegend }
  //
  // The editor's own read: the public route filters unavailable items out, and
  // an editor that cannot see them could never bring one back.
  app.get('/api/admin/menu', async () => loadAdminMenu());

  // --- Items ---------------------------------------------------------------

  // POST /api/admin/menu/items -> { item }
  app.post<{ Body: unknown }>('/api/admin/menu/items', async (req, reply) => {
    const item = await createMenuItem(parse(createItemSchema, req.body));
    reply.status(201);
    return { item };
  });

  // PATCH /api/admin/menu/items/:id -> { item }
  //
  // A field that is absent is left alone — including `allergenCodes`, which is
  // what stops a form that forgot the field from erasing an allergen.
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/admin/menu/items/:id',
    async (req) => {
      const item = await updateMenuItem(
        req.params.id,
        parse(updateItemSchema, req.body),
      );
      return { item };
    },
  );

  // POST /api/admin/menu/items/:id/available -> { item }
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/admin/menu/items/:id/available',
    async (req) => {
      const { available } = parse(availabilitySchema, req.body);
      const item = await setMenuItemAvailability(req.params.id, available);
      return { item };
    },
  );

  // DELETE /api/admin/menu/items/:id -> { deleted }
  app.delete<{ Params: { id: string } }>(
    '/api/admin/menu/items/:id',
    async (req) => {
      await deleteMenuItem(req.params.id);
      return { deleted: req.params.id };
    },
  );

  // --- Categories ----------------------------------------------------------

  // POST /api/admin/menu/categories -> { category }
  app.post<{ Body: unknown }>(
    '/api/admin/menu/categories',
    async (req, reply) => {
      const category = await createCategory(
        parse(createCategorySchema, req.body),
      );
      reply.status(201);
      return { category };
    },
  );

  // PATCH /api/admin/menu/categories/:id -> { category }
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/admin/menu/categories/:id',
    async (req) => {
      const category = await updateCategory(
        req.params.id,
        parse(updateCategorySchema, req.body),
      );
      return { category };
    },
  );

  // POST /api/admin/menu/categories/reorder -> { categories }
  app.post<{ Body: unknown }>(
    '/api/admin/menu/categories/reorder',
    async (req) => {
      const { ids } = parse(reorderCategoriesSchema, req.body);
      const categories = await reorderCategories(ids);
      return { categories };
    },
  );

  // DELETE /api/admin/menu/categories/:id -> { deleted }
  app.delete<{ Params: { id: string } }>(
    '/api/admin/menu/categories/:id',
    async (req) => {
      await deleteCategory(req.params.id);
      return { deleted: req.params.id };
    },
  );

  // --- Allergen legend -----------------------------------------------------

  // POST /api/admin/menu/allergens -> { allergen }
  //
  // The one-step route that lets the editor refuse an unknown allergen letter
  // as a typo without making an unresolved code unrepresentable (decision D2).
  app.post<{ Body: unknown }>(
    '/api/admin/menu/allergens',
    async (req, reply) => {
      const allergen = await upsertAllergen(parse(allergenSchema, req.body));
      reply.status(201);
      return { allergen };
    },
  );

  // DELETE /api/admin/menu/allergens/:code -> { deleted, stillUsedBy }
  app.delete<{ Params: { code: string } }>(
    '/api/admin/menu/allergens/:code',
    async (req) => {
      const result = await deleteAllergen(req.params.code);
      return { deleted: result.code, stillUsedBy: result.stillUsedBy };
    },
  );
}
