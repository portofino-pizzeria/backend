# Testing the Portofino backend

The suite is **integration-shaped on purpose**. Pricing, availability and
allergen resolution are all resolved *in the database* — a mocked Drizzle would
only ever test the mock. Every test runs against a real Postgres, through the
real Fastify app.

## Running it

```bash
cd backend
npm run db:up        # local Postgres (docker compose), once
npm test             # one run
npm run test:watch   # re-run on change
```

`npm test` creates the test database if it is missing, drops and re-applies the
migrations, and then runs every file in `test/`.

**It never skips.** If no Postgres answers, the run fails with an actionable
message telling you to start it. A suite that silently passes with zero tests
run is worse than a red one.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `TEST_DATABASE_URL` | `postgres://portofino:portofino@localhost:5432/portofino_test` | Where the suite runs. |
| `ALLOW_UNSAFE_TEST_DATABASE` | unset | Set to `1` to allow a database whose name does not contain `test`. |

The harness **refuses to run against a database whose name does not contain
"test"** (`test/support/database.ts`). It drops and recreates the `public`
schema on every run, so pointing it at `portofino` would destroy your dev data.
The override exists only for a CI database you cannot rename.

`DATABASE_URL`, `KITCHEN_TOKEN`, `OWNER_MENU_TOKEN`, `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` are all controlled by the harness
(`test/support/env.ts`), so the suite behaves the same whatever is in your
shell. Both guards fail CLOSED, so the harness has to opt each one in to
exercise its routes at all: `KITCHEN_TOKEN` is cleared **and**
`KITCHEN_AUTH_DISABLED=1` is set, which runs the kitchen routes with no auth;
`OWNER_MENU_TOKEN` is **set** (`TEST_OWNER_MENU_TOKEN`), because the owner's
editor has no opt-out. `test/kitchen-auth.test.ts` and `test/admin-menu.test.ts`
each undo their own opt-in again, in a controlled way, for the fail-closed test
itself — through the shared `withConfig` in `test/support/config.ts`, which
patches `config` in place for one test and restores it after.

## How the database fixture works

```
vitest run
 ├─ test/global-setup.ts          once per run
 │    ├─ CREATE DATABASE portofino_test   (if missing)
 │    ├─ DROP SCHEMA public, drizzle       ← forces a full re-apply
 │    └─ apply backend/drizzle/*.sql
 └─ per test file
      └─ test/support/setup.ts    (vitest `setupFiles`)
           ├─ import './env'      ← redirects src/config.ts, MUST be first
           └─ beforeEach: TRUNCATE every public table, RESTART IDENTITY
                          then seedShop()  ← the restaurant's own facts
```

Four things are worth knowing:

1. **Import order is load-bearing.** `src/config.ts` reads
   `process.env.DATABASE_URL` once, at module evaluation, and
   `src/db/client.ts` opens its connection pool from it immediately. So
   `test/support/env.ts` has to be evaluated before anything under `src/`.
   `import './env';` is the first import of `setup.ts`, and ES modules are
   evaluated in source order, which makes that a guarantee. `setup.ts` then
   asserts `config.databaseUrl` really is the test URL and throws if it is not
   — a broken ordering fails the run instead of quietly truncating your dev
   database.
2. **The truncate list is derived from the live catalogue**, not hard-coded, so
   a table added by a later migration is cleaned without anyone remembering to
   edit the harness.
3. **Test files do not run in parallel** (`fileParallelism: false` in
   `vitest.config.ts`) — they share one database and truncate between tests.
4. **The shop is re-seeded after every truncate.** Opening hours, the address,
   the phone number and the two pre-filled special days are rows now
   (`shop_profile`, `shop_weekly_hours`, `shop_special_days`), and the truncate
   above removes them — so `beforeEach` calls the same `seedShop()`
   (`src/db/seed-shop.ts`) a boot calls. Every test therefore starts from the
   shop a freshly-seeded production database has, and `GET /api/shop` answers
   instead of 503. A test that needs different hours edits those rows (see
   `test/shop.test.ts`); one that needs none deletes them.

Migrations are re-applied from an empty schema on every run, so "a clean,
migrated schema" is literally true rather than "whatever the last run left
behind".

## How to add a test

Put a `*.test.ts` under `test/`. Build the app once per file and drive it with
`app.inject()` — no port binding, no HTTP client, no flake, and the *real*
error handler (`src/app.ts` is shared between the server process and the
tests, so the `{ error }` body a test asserts on is the one production sends).

```ts
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createTestApp } from './support/app';
import { seedItem, seedLegend } from './support/fixtures';

let app: FastifyInstance;
beforeAll(async () => { app = await createTestApp(); });
afterAll(async () => { await app.close(); });

it('returns an unresolved allergen code flagged, not dropped', async () => {
  await seedLegend([{ code: 'a', labelDe: 'Glutenhaltiges Getreide' }]);
  await seedItem({ id: 'tonno', name: 'Tonno', allergenCodes: ['a', 'd'] });

  const menu = await app.inject({ method: 'GET', url: '/api/menu' }).then(r => r.json());

  expect(menu.allergenLegend).toContainEqual({
    code: 'd', label: 'unbekannt', labelEn: 'unknown', resolved: false,
  });
});
```

No cleanup is needed — the database is truncated before every test.

## Fixture API (`test/support/fixtures.ts`)

Every field is optional and has a default, so a test names only what it is
actually about.

```ts
seedCategory(input?: {
  id?: string;                      // default 'pizza'
  label?: string;                   // German, authoritative; default 'Pizza'
  labelEn?: string | null;
  sortOrder?: number;
}): Promise<MenuCategoryRow>         // upsert — re-seeding an id updates it

seedItem(input?: {
  id?: string;                      // default: slug of `name`
  number?: string | null;           // the number printed on the menu ('1', '76a')
  name?: string;                    // German; default 'Testartikel <n>'
  nameEn?: string | null;
  description?: string;
  descriptionEn?: string | null;
  categoryId?: string;              // created automatically if missing
  allergenCodes?: string[];         // verbatim; a code with no legend row is legal
  imageUrl?: string | null;
  available?: boolean;              // default true
  sortOrder?: number;
  variants?: SeedVariantInput[];    // omit => one variant; [] => none at all
}): Promise<MenuItemRow & { variants: MenuItemVariantRow[] }>

seedVariant(itemId: string, input?: {
  id?: string;                      // default `${itemId}-${slug(label)}`
  label?: string;                   // German: 'klein', 'groß', 'Blech', 'Schwein'
  sortOrder?: number;
  priceCents?: number;              // integer cents; never null
}): Promise<MenuItemVariantRow>

seedLegendEntry(input: {
  code: string;                     // verbatim: 'a', 'V', '1'
  labelDe?: string;                 // German, authoritative
  labelEn?: string | null;
  sortOrder?: number;
}): Promise<AllergenLegendRow>      // upsert

seedLegend(entries: SeedLegendInput[]): Promise<AllergenLegendRow[]>
                                    // array order becomes sortOrder

// For "edit the menu after something referenced it" tests — order-line
// snapshots today, the owner's editor in Phase 4b.
updateMenuItem(id: string, patch: Partial<MenuItemInsert>): Promise<MenuItemRow>
updateMenuVariant(id: string, patch: Partial<MenuItemVariantInsert>): Promise<MenuItemVariantRow>
deleteMenuItem(id: string): Promise<void>

slugify(value: string): string      // 'groß' -> 'gross', German-aware
resetFixtureCounters(): void        // called for you in beforeEach
```

`createTestApp()` in `test/support/app.ts` returns the production Fastify
instance with logging off. Close it in `afterAll`.

## What is covered today

| File | Covers |
|---|---|
| `test/harness.test.ts` | The harness itself: it is pointed at a test database, it refuses a non-test one, tests are isolated from each other, fixture defaults behave |
| `test/menu.test.ts` | `GET /api/menu` — payload shape, category/item/variant ordering, availability filtering, items with zero variants, and allergen resolution (a code with no legend row comes back `resolved: false` / `unbekannt`, never dropped) |
| `test/orders.test.ts` | `POST /api/orders` — per-variant server-side pricing, client-supplied prices ignored, every refusal path (unknown variant, variant of another item, missing variant at the zod door, unknown item, unavailable item, empty order, bad quantity, no partial write), the required contact details (missing, whitespace-only, zero-width-only, wrong-typed, over-long and too-few-digit name/phone/address, each answered with its exact German message, and stored cleaned and trimmed), and that order lines are snapshots that survive a later menu edit or deletion |
| `test/health.test.ts` | `GET /api/health` — the deploy workflow's proof surface: `commit` (present, degrades to `"unknown"` without the build arg), `kitchen` (`token` / `auth-disabled` / `unconfigured`, and that it never carries the token itself) and `legal` (all three states, that it still answers 200 when the shop rules cannot be read at all, and that a failed read keeps the last known answer) |
| `test/shop.test.ts` | Opening hours: Berlin wall time, the NRW public holidays, the window of one day, the status now, the printed table (`displayHours`, which must print exactly what the old hand-written constant printed), the two pre-filled D4 rows, and `GET /api/shop` — including a full-body literal captured from the behaviour at `bdaaeac`, so moving the facts into the database changed nothing a diner reads. Plus the proof that the rows really decide: a dated special day opens a Tuesday, moving the Ruhetag moves the refusal, and a shop with no profile row refuses every order with 503 |
| `test/kitchen-auth.test.ts` | The kitchen guard fails CLOSED: no token and no opt-out refuses with no order data in the body; the explicit `KITCHEN_AUTH_DISABLED` opt-out serves and is parsed as exactly `1` (a fresh import of `config.ts` per value — `true`, `yes`, `0`, empty all leave the guard armed); a configured token is required even with the opt-out set, and a wrong, same-length, prefix or empty bearer is refused |
| `test/admin-menu.test.ts` | `/api/admin/menu/*` — the owner's editor. The fail-closed credential (D5), the editor's own read, the **four safety properties** below, that editing the menu never rewrites order history, and the everyday item / category / allergen-legend edits |
| `test/admin-shop.test.ts` | `/api/admin/shop/*` — the owner's restaurant editor. The fail-closed credential (shared with the menu editor), and one `describe` per safety rule of decision D5: each part saved whole (all seven weekdays, a 62-day Urlaub in one transaction, a batch rejected as a whole), impossible states refused, closing the whole week confirmed, the phone number normalised on the server, a stale `version` answered with 409, every write undoable (and a second undo a redo), and a preview that writes nothing and shows exactly the status the public route will serve. Plus the Impressum: `confirmed: true` required, `email` written only here, and the register fields omitted from `GET /api/shop` while unset |

## The editor's four safety properties

The owner's menu editor writes the allergens and prices a diner reads, so its
gate is this suite rather than a typecheck. Each property in `domain_spec/menu`
(8) has its own `describe` in `test/admin-menu.test.ts`, and every test name
starts with the property number so a red run says which one broke.

| Property | Enforced by | Named in |
|---|---|---|
| 1. Allergens cannot be lost silently | `assertAllergenIntent` — an absent `allergenCodes` leaves the stored codes untouched; an empty one needs `confirmNoAllergens: true` | `property 1: …` (6 tests) |
| 2. Validation refuses impossible states | `normaliseVariants`, `assertCategoryExists`, `assertOrderable`, `assertCodesAreKnown` | `property 2: …` (10 tests) |
| 3. An interrupted edit leaves the previous good version live | one `db.transaction` per write | `property 3: …` (2 tests) |
| 4. A half-saved item never reaches a diner | the item row and its variants share that transaction | `property 4: …` (2 tests) |

Properties 3 and 4 are tested with a **real** mid-write failure, not a mock: the
request names a variant id that already belongs to another item, so the rename,
the variant delete and the variant update all reach Postgres before the insert
trips the primary key. The assertion is that `GET /api/menu` comes back
byte-for-byte identical (`publicMenuSnapshot()`).

Do not add `it.skip` to close a gate. A skipped test is a lie in a green suite.
