// D4 — the retention sweep.
//
// The clock is pinned (`src/lib/clock.ts`), because every assertion here is
// about an age and an unpinned suite would answer differently every month.
// Ages are set by writing `created_at` directly: the column is `defaultNow()`
// in the database, so it does not go through the pinned clock the way
// order-service's opening-hours check does.

import { readFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { config, positiveIntFromEnv } from '../src/config.js';
import { db, sql } from '../src/db/client.js';
import { orderLines, orders, retentionRuns } from '../src/db/schema.js';
import { setNowForTests } from '../src/lib/clock.js';
import { newOrderAccessToken } from '../src/lib/order-service.js';
import {
  RETENTION_LOCK_KEY,
  RETENTION_MARKER,
  monthsBefore,
  runRetentionSweep,
  yearsBefore,
} from '../src/lib/retention.js';

/** The instant every test in this file pretends it is. */
const TODAY = new Date('2026-09-20T12:00:00.000Z');

afterEach(() => {
  setNowForTests(null);
});

interface SeedOrderOptions {
  ageMonths?: number;
  ageYears?: number;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
}

let seq = 0;

/** An order of a chosen age, with a line, written straight to the database. */
async function seedOrder(options: SeedOrderOptions = {}): Promise<string> {
  const createdAt = options.ageYears
    ? yearsBefore(TODAY, options.ageYears)
    : monthsBefore(TODAY, options.ageMonths ?? 0);

  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  await db.insert(orders).values({
    id,
    accessToken: newOrderAccessToken(),
    subtotal: 790,
    deliveryFee: 299,
    total: 1089,
    currency: 'EUR',
    status: 'ready',
    fulfilment: 'delivery',
    customerName: options.name === undefined ? 'Anna' : options.name,
    customerPhone: options.phone === undefined ? '0201 5415883' : options.phone,
    customerAddress:
      options.address === undefined ? 'Teststraße 7, 45127 Essen' : options.address,
    customerNotes: options.notes === undefined ? 'Bitte klingeln' : options.notes,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(orderLines).values({
    orderId: id,
    menuItemId: 'margherita',
    variantId: 'margherita-gross',
    name: 'Margherita',
    variantLabel: 'groß',
    unitPrice: 790,
    quantity: 1,
  });
  return id;
}

async function readOrderRow(id: string) {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
}

describe('runRetentionSweep — the two periods', () => {
  it('clears phone, address and notes on an order past the contact period, keeping the name', async () => {
    setNowForTests(TODAY);
    const id = await seedOrder({ ageMonths: 7 });

    const result = await runRetentionSweep();

    expect(result.ran).toBe(true);
    expect(result.contactCleared).toBe(1);
    expect(result.ordersDeleted).toBe(0);

    const row = await readOrderRow(id);
    expect(row.customerName).toBe('Anna');
    expect(row.customerPhone).toBeNull();
    expect(row.customerAddress).toBeNull();
    expect(row.customerNotes).toBeNull();
    // Minimisation is not erasure — the Art. 17 stamp stays clear.
    expect(row.personalDataErasedAt).toBeNull();
    // And the books are untouched.
    expect(row.subtotal).toBe(790);
    expect(row.total).toBe(1089);
  });

  it('leaves an order inside the contact period completely alone', async () => {
    setNowForTests(TODAY);
    const id = await seedOrder({ ageMonths: 5 });

    const result = await runRetentionSweep();

    expect(result.contactCleared).toBe(0);
    const row = await readOrderRow(id);
    expect(row.customerName).toBe('Anna');
    expect(row.customerPhone).toBe('0201 5415883');
    expect(row.customerAddress).toBe('Teststraße 7, 45127 Essen');
    expect(row.customerNotes).toBe('Bitte klingeln');
  });

  it('deletes an order past the commercial-retention period, and its lines with it', async () => {
    setNowForTests(TODAY);
    const doomed = await seedOrder({ ageYears: 11 });
    const kept = await seedOrder({ ageYears: 9 });

    const result = await runRetentionSweep();

    expect(result.ordersDeleted).toBe(1);
    expect(await readOrderRow(doomed)).toBeUndefined();
    expect(await readOrderRow(kept)).toBeDefined();

    // `order_lines` cascades from `orders.id`.
    const lines = await db
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, doomed));
    expect(lines).toHaveLength(0);
  });

  it('keeps a 9-year-old order but has already minimised it', async () => {
    setNowForTests(TODAY);
    const id = await seedOrder({ ageYears: 9 });

    await runRetentionSweep();

    const row = await readOrderRow(id);
    expect(row).toBeDefined();
    expect(row.customerName).toBe('Anna');
    expect(row.customerPhone).toBeNull();
  });

  it('is idempotent — a forced second sweep changes nothing further', async () => {
    setNowForTests(TODAY);
    const id = await seedOrder({ ageMonths: 7 });

    const first = await runRetentionSweep();
    const firstRow = await readOrderRow(id);

    const second = await runRetentionSweep({ force: true });
    const secondRow = await readOrderRow(id);

    expect(first.contactCleared).toBe(1);
    // Nothing left to clear, so the second sweep touches no rows at all — not
    // even to bump `updated_at`, which a blanket UPDATE would have done to
    // every historical order on every run.
    expect(second.contactCleared).toBe(0);
    expect(second.ordersDeleted).toBe(0);
    expect(secondRow.updatedAt.toISOString()).toBe(firstRow.updatedAt.toISOString());
  });
});

describe('runRetentionSweep — it runs at most once per period', () => {
  it('is a no-op inside the configured period (the last-run marker)', async () => {
    setNowForTests(TODAY);
    await seedOrder({ ageMonths: 7 });

    const first = await runRetentionSweep();
    expect(first.ran).toBe(true);

    // Same instant, so well inside `sweepIntervalHours`.
    const second = await runRetentionSweep();
    expect(second.ran).toBe(false);
    expect(second.skipped).toBe('not-due');
    expect(second.contactCleared).toBe(0);
  });

  it('runs again once the period has elapsed', async () => {
    setNowForTests(TODAY);
    await runRetentionSweep();

    const later = new Date(
      TODAY.getTime() + (config.retention.sweepIntervalHours + 1) * 60 * 60 * 1000,
    );
    setNowForTests(later);
    const id = await seedOrder({ ageMonths: 7 });

    const again = await runRetentionSweep();

    expect(again.ran).toBe(true);
    expect((await readOrderRow(id)).customerPhone).toBeNull();
  });

  it('writes the marker as "that, and when" — one row, no version', async () => {
    setNowForTests(TODAY);
    await runRetentionSweep();

    const rows = await db.select().from(retentionRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(RETENTION_MARKER);
    expect(rows[0].lastRunAt.toISOString()).toBe(TODAY.toISOString());
  });

  it('does not touch dataset_seeds, whose contract is the menu bootstrap', async () => {
    setNowForTests(TODAY);
    await runRetentionSweep();

    const seeds = await sql`select * from dataset_seeds`;
    expect(seeds).toHaveLength(0);
  });
});

describe('runRetentionSweep — only one instance does the work', () => {
  it('is a no-op while another holds the advisory lock', async () => {
    setNowForTests(TODAY);
    const id = await seedOrder({ ageMonths: 7 });

    // Hold the lock inside a transaction on one pooled connection, exactly as
    // a second App Runner instance mid-sweep would. The sweep then runs on a
    // different connection from the same pool. Deterministic: no race to lose.
    await sql.begin(async (held) => {
      const [taken] = await held<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) as locked
      `;
      expect(taken.locked).toBe(true);

      const result = await runRetentionSweep();

      expect(result.ran).toBe(false);
      expect(result.skipped).toBe('locked');
      // And, crucially, it did not do half the work before giving up.
      expect((await readOrderRow(id)).customerPhone).toBe('0201 5415883');
    });
  });

  it('lets exactly one of two concurrent sweeps do the work', async () => {
    setNowForTests(TODAY);
    await seedOrder({ ageMonths: 7 });

    const [a, b] = await Promise.all([runRetentionSweep(), runRetentionSweep()]);

    // Whichever way they interleave, the loser is stopped either by the lock
    // or by the marker the winner just wrote. Both are no-ops.
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
    expect(a.contactCleared + b.contactCleared).toBe(1);
  });

  it('releases the lock with the transaction, so the next sweep can take it', async () => {
    setNowForTests(TODAY);
    await runRetentionSweep();

    // Session-scoped `pg_try_advisory_lock` on a pooled connection would leak
    // here: taken on one connection, unlocked on another. The transaction form
    // cannot. If it had leaked, this forced sweep would answer 'locked'.
    const next = await runRetentionSweep({ force: true });
    expect(next.ran).toBe(true);
  });
});

describe('the sweep is wired in after initDatabase, not inside its retry loop', () => {
  it('calls startRetentionSweeps from main(), after the await', async () => {
    // A wiring guard rather than a behavioural one: `main()` listens on a port,
    // so it cannot be driven from a test. What it must never become is a call
    // inside `initDatabase`, which retries up to 20 times and serves anyway on
    // total failure — 20 delete sweeps per boot.
    // Normalised: the file is checked out with CRLF on Windows.
    const source = (
      await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    ).replace(/\r\n/g, '\n');

    const initBody = /async function initDatabase\([\s\S]*?\n}\n/.exec(source)?.[0];
    expect(initBody).toBeDefined();
    expect(initBody).not.toContain('startRetentionSweeps');
    expect(initBody).not.toContain('runRetentionSweep');

    const callIndex = source.indexOf('startRetentionSweeps(app.log)');
    const awaitIndex = source.indexOf('await initDatabase(app)');
    expect(awaitIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(awaitIndex);
  });
});

describe('the period arithmetic', () => {
  it('never rolls a month-end forward, which would delete early', () => {
    // 31 August minus 6 months is 31 February. Naive `setUTCMonth` normalises
    // that to 3 March — a cutoff LATER than asked for, i.e. deleting data a few
    // days early. Clamping moves it earlier instead.
    expect(monthsBefore(new Date('2026-08-31T00:00:00Z'), 6).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(monthsBefore(new Date('2028-08-31T00:00:00Z'), 6).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    expect(yearsBefore(new Date('2028-02-29T00:00:00Z'), 1).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });

  it('ships the documented defaults', () => {
    expect(config.retention.contactMonths).toBe(6);
    expect(config.retention.orderYears).toBe(10);
    expect(config.retention.sweepIntervalHours).toBe(24);
  });

  it('falls back to the default rather than to NaN or zero', () => {
    // A misspelt RETENTION_CONTACT_MONTHS must not become NaN — every age
    // comparison would be false and the sweep would silently do nothing — nor
    // 0, which would clear every order's phone number on the first run.
    const KEY = 'RETENTION_TEST_ONLY_VALUE';
    const previous = process.env[KEY];
    try {
      for (const nonsense of ['', 'six', '0', '-1', '2.5', ' ']) {
        process.env[KEY] = nonsense;
        expect(positiveIntFromEnv(KEY, 6)).toBe(6);
      }
      process.env[KEY] = '3';
      expect(positiveIntFromEnv(KEY, 6)).toBe(3);
      delete process.env[KEY];
      expect(positiveIntFromEnv(KEY, 6)).toBe(6);
    } finally {
      if (previous === undefined) delete process.env[KEY];
      else process.env[KEY] = previous;
    }
  });
});
