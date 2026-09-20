// The owner's restaurant editor — `/api/admin/shop/*`.
//
// Same guard, same credential and same shape as the menu editor next door
// (`admin-menu.ts`): zod at the door for the shape of a request, and
// `lib/shop-admin-service.ts` for the rules that need the database to decide.
// Every part is saved WHOLE — seven weekdays in one request, a whole holiday
// in one request — so no request can leave the week half-updated.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { badRequest } from '../lib/http-errors.js';
import { requireOwnerAuth } from '../lib/owner-auth.js';
import {
  addSpecialDays,
  deleteSpecialDay,
  loadAdminShop,
  previewShop,
  saveHours,
  saveLegal,
  saveProfile,
  undoLastChange,
  updateSpecialDay,
} from '../lib/shop-admin-service.js';

/** The version the editor read the shop at. Every write carries it (D5.5). */
const version = z.number({
  required_error:
    'Bitte die Version mitsenden, mit der die Seite geladen wurde (version).',
  invalid_type_error: 'Die Version muss eine Zahl sein (version).',
}).int();

const text = (max: number) => z.string().max(max);

const profileSchema = z.object({
  name: z.string({ required_error: 'Das Restaurant braucht einen Namen.' }).max(200),
  street: z.string({ required_error: 'Die Straße fehlt.' }).max(200),
  postalCode: z.string({ required_error: 'Die Postleitzahl fehlt.' }).max(20),
  city: z.string({ required_error: 'Der Ort fehlt.' }).max(200),
  phoneDisplay: z
    .string({ required_error: 'Die Telefonnummer fehlt.' })
    .max(60),
  version,
});

const weekdaySchema = z.object({
  weekday: z.number({ required_error: 'Jeder Tag braucht eine Nummer (1 = Montag … 7 = Sonntag).' }).int(),
  open: text(5).nullable(),
  close: text(5).nullable(),
});

const hoursSchema = z.object({
  weekly: z
    .array(weekdaySchema, {
      required_error:
        'Die Öffnungszeiten werden immer für die ganze Woche gespeichert (weekly).',
    })
    .max(7),
  deliveryUntil: z.string({ required_error: '„Lieferung bis“ fehlt.' }).max(5),
  holidayOpen: z.string({ required_error: 'Die Feiertags-Öffnungszeit fehlt.' }).max(5),
  holidayClose: z.string({ required_error: 'Die Feiertags-Schließzeit fehlt.' }).max(5),
  ruhetagBeatsHoliday: z.boolean({
    required_error:
      'Bitte angeben, ob ein Ruhetag auch an Feiertagen gilt (ruhetagBeatsHoliday).',
  }),
  confirmAllClosed: z.boolean().optional(),
  version,
});

const legalSchema = z.object({
  legalOwnerName: text(200).nullable().optional(),
  legalForm: text(200).nullable().optional(),
  email: text(200).nullable().optional(),
  vatId: text(60).nullable().optional(),
  registerCourt: text(200).nullable().optional(),
  registerNumber: text(60).nullable().optional(),
  confirmed: z.boolean({
    required_error:
      'Bitte bestätigen, dass die Angaben im Impressum korrekt und vollständig sind.',
  }),
  version,
});

const specialDaySchema = z.object({
  date: text(10).nullable().optional(),
  monthDay: text(5).nullable().optional(),
  closed: z.boolean().default(false),
  open: text(5).nullable().optional(),
  close: text(5).nullable().optional(),
  deliveryUntil: text(5).nullable().optional(),
  note: text(300).optional(),
});

const specialDaysSchema = z.object({
  // 62 is two months of consecutive days — the longest "Urlaub eintragen" the
  // editor offers, written in ONE transaction so a holiday is never half
  // entered.
  days: z
    .array(specialDaySchema, {
      required_error: 'Bitte die Tage als Liste senden (days).',
    })
    .min(1, 'Bitte mindestens einen Tag angeben.')
    .max(62, 'Auf einmal können höchstens 62 Tage eingetragen werden.'),
  version,
});

const specialDayPatchSchema = specialDaySchema.extend({ version });

const previewSchema = z.object({
  weekly: z.array(weekdaySchema).max(7).optional(),
  deliveryUntil: text(5).optional(),
  holidayOpen: text(5).optional(),
  holidayClose: text(5).optional(),
  ruhetagBeatsHoliday: z.boolean().optional(),
  specialDays: z.array(specialDaySchema).max(400).optional(),
});

const undoSchema = z.object({ version });

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

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw badRequest('Diesen Sondertag gibt es nicht (mehr).');
  }
  return id;
}

export async function adminShopRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireOwnerAuth);

  // GET /api/admin/shop -> AdminShop
  //
  // The editor's own read: it carries the version every write has to quote,
  // the ids of the special days, and the `confirmed` flag the public route has
  // no use for.
  app.get('/api/admin/shop', async () => loadAdminShop());

  // PUT /api/admin/shop/profile -> AdminShop
  app.put<{ Body: unknown }>('/api/admin/shop/profile', async (req) =>
    saveProfile(parse(profileSchema, req.body)),
  );

  // PUT /api/admin/shop/hours -> AdminShop
  app.put<{ Body: unknown }>('/api/admin/shop/hours', async (req) =>
    saveHours(parse(hoursSchema, req.body)),
  );

  // PUT /api/admin/shop/legal -> AdminShop
  //
  // The only writer of `email`: it is an Impressum fact, and it is saved
  // together with the confirmation that the whole notice is correct.
  app.put<{ Body: unknown }>('/api/admin/shop/legal', async (req) =>
    saveLegal(parse(legalSchema, req.body)),
  );

  // POST /api/admin/shop/special-days -> AdminShop
  app.post<{ Body: unknown }>('/api/admin/shop/special-days', async (req) => {
    const { days, version: at } = parse(specialDaysSchema, req.body);
    return addSpecialDays(days, at);
  });

  // PATCH /api/admin/shop/special-days/:id -> AdminShop
  //
  // The whole row, and it marks the row confirmed — which is how the two
  // pre-filled D4 rows (Heiligabend, Silvester) stop being "Vorbelegt".
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/admin/shop/special-days/:id',
    async (req) => {
      const { version: at, ...day } = parse(specialDayPatchSchema, req.body);
      return updateSpecialDay(parseId(req.params.id), day, at);
    },
  );

  // DELETE /api/admin/shop/special-days/:id?version=N -> AdminShop
  app.delete<{ Params: { id: string }; Querystring: { version?: string } }>(
    '/api/admin/shop/special-days/:id',
    async (req) => {
      const at = Number(req.query.version);
      if (!Number.isInteger(at)) {
        throw badRequest(
          'Bitte die Version mitsenden, mit der die Seite geladen wurde (version).',
        );
      }
      return deleteSpecialDay(parseId(req.params.id), at);
    },
  );

  // POST /api/admin/shop/preview -> { display, status, days }
  //
  // Writes nothing and needs no version — it is what "So sehen es Ihre Gäste"
  // renders before the owner commits to a save.
  app.post<{ Body: unknown }>('/api/admin/shop/preview', async (req) =>
    previewShop(parse(previewSchema, req.body ?? {})),
  );

  // POST /api/admin/shop/undo -> AdminShop
  app.post<{ Body: unknown }>('/api/admin/shop/undo', async (req) => {
    const { version: at } = parse(undoSchema, req.body);
    return undoLastChange(at);
  });
}
