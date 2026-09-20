// Decision D4 — retention, enforced.
//
// Before this, nothing in the system ever removed a name, a phone number or an
// address. The only Speicherdauer a privacy policy could honestly publish was
// "indefinitely", which is not what anybody intended.
//
// Two passes, both driven off `orders.created_at`:
//
//   after `retention.contactMonths` (6)  -> phone, address and note -> NULL
//   after `retention.orderYears`   (10)  -> the order and its lines -> deleted
//
// The name survives the first pass because it is part of the commercial record
// §147 AO / §257 HGB keeps; the phone number, the delivery address and the
// free-text note are not, and none of them belongs in a tax record.
//
// ---------------------------------------------------------------------------
// Why this is not a `setInterval` that deletes things
// ---------------------------------------------------------------------------
//
// Two premises that would have made a naive daily timer correct are both false
// here:
//
//   * **There is not one instance.** `infra/backend-service.tf` sets no
//     `auto_scaling_configuration_arn` and no autoscaling configuration
//     resource exists, so the service runs on App Runner's
//     `DefaultConfiguration` — MinSize 1, **MaxSize 25**. A per-process timer
//     fires on every instance.
//   * **A daily timer is not a daily run.** `auto_deployments_enabled = true`
//     against `:latest`, and the deploy workflow pushes on every merge to
//     master, so the process restarts often and resets any interval. App
//     Runner also does not promise background work on an idle instance.
//
// So `runRetentionSweep()` is idempotent and guards itself twice:
//
//   1. a Postgres **advisory lock**, taken for the transaction, so only one of
//      up to 25 instances does the work in any overlapping window; and
//   2. a **last-run marker** (`retention_runs`), so "daily" means *at most once
//      per period* rather than *once per timer tick* — which is what makes a
//      restart-heavy deploy model run the sweep MORE often rather than never.
//
// The lock is `pg_try_advisory_xact_lock`, not `pg_try_advisory_lock`. The
// session-scoped form would be taken on whichever pooled connection the query
// landed on and released on whichever connection the unlock landed on — a
// different one, in general, which leaks the lock permanently. The transaction
// form is released by the transaction itself, on the connection that took it.

import { and, eq, gte, isNotNull, lt, or, sql as raw } from 'drizzle-orm';

import { config } from '../config.js';
import { now } from './clock.js';
import { db } from '../db/client.js';
import { orders, retentionRuns } from '../db/schema.js';

/**
 * The advisory-lock key. An arbitrary but FIXED integer — every instance must
 * pick the same one or the lock guards nothing.
 *
 * Kept inside int4 range on purpose. The lock functions take a `bigint`, and a
 * JavaScript number above 2^31 is sent by postgres.js as a float, which no
 * longer resolves to `pg_try_advisory_xact_lock(bigint)`. An int4 is implicitly
 * widened and resolves cleanly.
 */
export const RETENTION_LOCK_KEY = 0x504f5254; // 1347703892 — "PORT" in ASCII

/** The `retention_runs` row this sweep owns. */
export const RETENTION_MARKER = 'orders';

export interface RetentionSweepResult {
  /** True only when the sweep actually did the work and moved the marker. */
  ran: boolean;
  /** Why it did not, when it did not. */
  skipped?: 'locked' | 'not-due';
  /** Orders whose phone, address and note were cleared by this run. */
  contactCleared: number;
  /** Orders deleted outright by this run (their lines cascade). */
  ordersDeleted: number;
}

const NOTHING = { contactCleared: 0, ordersDeleted: 0 };

/**
 * `instant` minus `months`, clamped so a month-end never rolls forward.
 *
 * `setUTCMonth` overflows: 31 August minus 6 months is 31 February, which
 * Postgres-free JavaScript normalises to 3 March — a cutoff LATER than asked
 * for, which would delete data early. Clamping to the last day of the target
 * month moves the cutoff slightly EARLIER instead, i.e. keeps data slightly
 * longer. That is the safe direction, and it is the direction D4 picks
 * everywhere: keeping a record too long is recoverable, deleting it early is
 * not.
 */
export function monthsBefore(instant: Date, months: number): Date {
  const day = instant.getUTCDate();
  const shifted = new Date(instant.getTime());
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return shifted;
}

/** `instant` minus `years`, with the same clamping (29 February). */
export function yearsBefore(instant: Date, years: number): Date {
  return monthsBefore(instant, years * 12);
}

/**
 * Run the sweep, at most once per configured period, at most once across
 * instances.
 *
 * Safe to call on every boot and on every interval tick — that is the point.
 * It never throws on contention: a losing instance gets `skipped: 'locked'`,
 * and a caller inside the period gets `skipped: 'not-due'`.
 *
 * `force` skips the marker check only. It exists for the tests and for an
 * operator running the sweep by hand after changing a period; it does NOT skip
 * the lock, because two forced sweeps racing is still exactly one sweep's worth
 * of work.
 */
export async function runRetentionSweep(
  options: { force?: boolean } = {},
): Promise<RetentionSweepResult> {
  const at = now();

  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ locked: boolean }>(
      raw`select pg_try_advisory_xact_lock(${RETENTION_LOCK_KEY}) as locked`,
    );
    if (!locked[0]?.locked) {
      return { ran: false, skipped: 'locked' as const, ...NOTHING };
    }

    if (!options.force) {
      const [marker] = await tx
        .select()
        .from(retentionRuns)
        .where(eq(retentionRuns.name, RETENTION_MARKER));
      const intervalMs = config.retention.sweepIntervalHours * 60 * 60 * 1000;
      if (marker && at.getTime() - marker.lastRunAt.getTime() < intervalMs) {
        return { ran: false, skipped: 'not-due' as const, ...NOTHING };
      }
    }

    // Pass 1 — minimisation. Three of the four customer columns, on orders
    // past the contact period. The name stays: it is part of the record the
    // commercial-retention obligation keeps.
    //
    // `personal_data_erased_at` is deliberately NOT stamped. That column means
    // "the owner erased this on a data-subject request" (D5); a partial
    // minimisation is a different event and must not claim to be that one.
    const contactCutoff = monthsBefore(at, config.retention.contactMonths);
    const orderCutoff = yearsBefore(at, config.retention.orderYears);
    const cleared = await tx
      .update(orders)
      .set({
        customerPhone: null,
        customerAddress: null,
        customerNotes: null,
        updatedAt: at,
      })
      .where(
        and(
          lt(orders.createdAt, contactCutoff),
          // Not the rows pass 2 is about to delete outright. The contact
          // cutoff is a superset of the deletion cutoff, so without this an
          // 11-year-old order is UPDATEd and then DELETEd in the same
          // transaction — and counted in BOTH numbers, which makes the log
          // line overstate what happened.
          gte(orders.createdAt, orderCutoff),
          // Only rows that still hold something, so a sweep over an
          // already-swept table is a genuine no-op rather than a mass UPDATE
          // that bumps `updated_at` on every historical order.
          or(
            isNotNull(orders.customerPhone),
            isNotNull(orders.customerAddress),
            isNotNull(orders.customerNotes),
          ),
        ),
      )
      .returning({ id: orders.id });

    // Pass 2 — deletion. The whole order, once the commercial-retention period
    // has run out. `order_lines` references `orders.id` with
    // `onDelete: 'cascade'`, so the lines go with it.
    const deleted = await tx
      .delete(orders)
      .where(lt(orders.createdAt, orderCutoff))
      .returning({ id: orders.id });

    await tx
      .insert(retentionRuns)
      .values({ name: RETENTION_MARKER, lastRunAt: at })
      .onConflictDoUpdate({
        target: retentionRuns.name,
        set: { lastRunAt: at },
      });

    return {
      ran: true,
      contactCleared: cleared.length,
      ordersDeleted: deleted.length,
    };
  });
}

/**
 * A minimal logger surface, so this module does not depend on Fastify.
 */
export interface SweepLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Sweep now, then on an interval, logging the outcome.
 *
 * Called from `index.ts` **after** `initDatabase()` returns — never inside its
 * retry loop, which retries up to 20 times and serves anyway on total failure.
 * A delete sweep in that loop could run 20 times in one boot.
 *
 * The first call is unconditional because the marker, not this call, decides
 * whether work happens: on a process that has just restarted mid-period it
 * answers `not-due` and costs one round trip.
 *
 * The returned handle stops the interval; the timer is `unref`'d so it never
 * holds the process open on its own.
 */
export function startRetentionSweeps(log: SweepLogger): { stop: () => void } {
  const run = async (): Promise<void> => {
    try {
      const result = await runRetentionSweep();
      if (result.ran) {
        log.info(
          `Retention sweep: cleared contact details on ${result.contactCleared} order(s), ` +
            `deleted ${result.ordersDeleted} order(s) past ${config.retention.orderYears} years.`,
        );
      }
    } catch (err) {
      // Never fatal. A failed sweep means data is kept too long for one
      // period, which the next tick fixes; a crashed API means no orders at
      // all.
      log.warn(`Retention sweep failed: ${(err as Error).message}`);
    }
  };

  void run();
  const timer = setInterval(
    () => void run(),
    config.retention.sweepIntervalHours * 60 * 60 * 1000,
  );
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
