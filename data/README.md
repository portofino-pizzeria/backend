# `data/`

## `menu.json` is not the live menu

`menu.json` is the captured Portofino menu. It has two jobs:

- **the bootstrap for a fresh database.** `seedMenu()` (`src/db/seed.ts`) loads
  it once, into a database that has never had a menu, and records that in the
  `menu` row of `dataset_seeds`;
- **the dataset test fixture** (`test/menu-dataset.test.ts`,
  `test/seed.test.ts`).

After the first seed the database is the menu, and the owner edits it in the
menu editor (`/api/admin/menu/*`). **Editing this file changes nothing in a
database that has been seeded**: no boot, deploy or restart reads it again,
and a boot that finds the menu already seeded logs that and writes nothing.

## Correcting the menu

- **Before cutover**, a correction ships as a data migration **and** the same
  edit to `menu.json`, in the same PR:
  1. `npx drizzle-kit generate --custom --name=<what>` creates an empty SQL
     file under `drizzle/` that is in the journal. Write the correction there,
     idempotently (it runs once per database, but may meet a database where
     the owner already changed the row). It is reviewed like any migration.
  2. Make the same change in `menu.json`. On a fresh database the migrations
     run before the seed, so the migration alone would act on empty tables
     and the seed would then load the old row.
- **After cutover**, the owner corrects the menu in the editor.

## The full reset

`npm run db:reseed -- --force` deletes the four menu tables, reloads them from
`menu.json` and rewrites the marker. **It erases every owner edit.** It refuses
without `--force`, and with `NODE_ENV=production` it also requires
`--i-know-this-erases-owner-edits`. It is for a local or staging database, not
a way to ship a correction.
