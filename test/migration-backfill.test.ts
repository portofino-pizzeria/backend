// The one property `0006_order_access_token.sql` has that the rest of the
// suite structurally cannot reach: **it backfills a table that already has
// rows.**
//
// `test/global-setup.ts` creates the test database empty and applies every
// migration to it, so the backfill always runs over zero rows there. The
// interesting case — a production `orders` table with real orders in it,
// where `ADD COLUMN ... NOT NULL` would fail outright — is exactly the one
// that never happens in the suite.
//
// So this file stands up a scratch database of its own, applies the migrations
// that existed BEFORE the column, writes orders the old way, and only then
// applies 0006 and 0007. It is the migration's only real test.

import { readFile, readdir } from 'node:fs/promises';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveTestDatabaseUrl, maintenanceDatabaseUrl, resolveSsl } from './support/database';

/** Named so the harness's "must look like a test database" rule is satisfied. */
const SCRATCH = 'portofino_test_migration_backfill';

let scratchUrl: string;
let sql: ReturnType<typeof postgres>;

/** Split a migration on drizzle's own breakpoint marker, as the migrator does. */
async function statementsOf(tag: string): Promise<string[]> {
  const body = await readFile(
    new URL(`../drizzle/${tag}.sql`, import.meta.url),
    'utf8',
  );
  return body
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function apply(tag: string): Promise<void> {
  for (const statement of await statementsOf(tag)) {
    await sql.unsafe(statement);
  }
}

beforeAll(async () => {
  const base = resolveTestDatabaseUrl();
  const adminUrl = maintenanceDatabaseUrl(base);
  scratchUrl = base.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH}$1`);

  const admin = postgres(adminUrl, {
    max: 1,
    ssl: resolveSsl(adminUrl),
    onnotice: () => {},
    connect_timeout: 10,
  });
  try {
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
    await admin.unsafe(`create database "${SCRATCH}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  sql = postgres(scratchUrl, {
    max: 1,
    ssl: resolveSsl(scratchUrl),
    onnotice: () => {},
    connect_timeout: 10,
  });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  const admin = postgres(maintenanceDatabaseUrl(resolveTestDatabaseUrl()), {
    max: 1,
    ssl: resolveSsl(resolveTestDatabaseUrl()),
    onnotice: () => {},
    connect_timeout: 10,
  });
  try {
    await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 60_000);

describe('0006 / 0007 against a table that already has orders', () => {
  it('gives every pre-existing row a distinct token and makes the column NOT NULL', async () => {
    // The world as it was before this branch.
    for (const tag of [
      '0000_parallel_preak',
      '0001_drop_single_price_menu_shape',
      '0002_menu_variants_categories_allergens',
      '0003_fulfilment_and_pickup_only',
      '0004_dataset_seeds',
    ]) {
      await apply(tag);
    }

    // Orders written the old way — no access_token column exists yet.
    await sql.unsafe(`
      insert into orders (id, subtotal, delivery_fee, total, customer_name, customer_phone)
      values ('old-a', 100, 0, 100, 'Anna', '0201 1'),
             ('old-b', 200, 0, 200, 'Bert', '0201 2'),
             ('old-c', 300, 0, 300, 'Cem',  '0201 3')
    `);

    // The change under test. `ADD COLUMN ... NOT NULL` alone would fail here.
    await apply('0006_order_access_token');
    await apply('0007_retention');

    const rows = await sql<{ id: string; access_token: string }[]>`
      select id, access_token from orders order by id
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.access_token).toMatch(/^[0-9a-f]{64}$/);
    }
    // Every row got its OWN token. A backfill with one shared value would be
    // worse than none: one leak would open every historical order.
    expect(new Set(rows.map((r) => r.access_token)).size).toBe(3);

    const [column] = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_name = 'orders' and column_name = 'access_token'
    `;
    expect(column.is_nullable).toBe('NO');

    // ...and the row keeps everything it had.
    const [anna] = await sql<{ customer_name: string; total: number }[]>`
      select customer_name, total from orders where id = 'old-a'
    `;
    expect(anna.customer_name).toBe('Anna');
    expect(anna.total).toBe(100);
  }, 60_000);

  it('adds 0007 without disturbing the backfilled rows', async () => {
    const [row] = await sql<{ personal_data_erased_at: Date | null }[]>`
      select personal_data_erased_at from orders where id = 'old-a'
    `;
    // A pre-existing order has not been erased on request; the Art. 17 stamp
    // must start clear rather than defaulting to "now".
    expect(row.personal_data_erased_at).toBeNull();

    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where tablename = 'orders'
    `;
    expect(indexes.map((i) => i.indexname)).toContain('orders_created_at_idx');

    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_name = 'retention_runs'
    `;
    expect(tables).toHaveLength(1);
  });

  it('applies every migration the journal names, and only those', async () => {
    // Guards the 0005 gap: the journal is the applying order, so a tag with no
    // file (or a file the journal forgot) is a broken deploy, not a tidy-up.
    const journal = JSON.parse(
      await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { idx: number; when: number; tag: string }[] };

    const files = (await readdir(new URL('../drizzle', import.meta.url)))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();

    expect(journal.entries.map((e) => e.tag).sort()).toEqual(files);

    // drizzle applies entries whose `when` is greater than the newest APPLIED
    // one, so a journal whose `when` values are out of order silently skips
    // migrations. See the header of 0006 for why this matters across branches.
    const whens = journal.entries.map((e) => e.when);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
  });
});
