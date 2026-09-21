-- D4: retention becomes a thing the server enforces rather than a sentence in a
-- policy. Today nothing ever removes a name, a phone number or an address, so
-- the only honest Speicherdauer a privacy policy could publish is "indefinitely".
--
-- Two additions:
--
-- 1. `orders.personal_data_erased_at` — stamped by D5's Art. 17 `forget`
--    endpoint when the owner erases one order's customer block on request. It
--    is deliberately NOT stamped by the retention sweep's six-month pass: that
--    pass clears three of the four fields and keeps the name, so it is
--    minimisation, not erasure, and conflating the two would make the column
--    lie about what happened to the row.
--
-- 2. `retention_runs` — the "this ran, and when" marker, in the shape
--    `dataset_seeds` already established for exactly that question. It is a
--    SEPARATE table on purpose: `dataset_seeds`' contract is "that, and when,
--    never a version", scoped to the menu and shop bootstraps, and overloading
--    it would couple a delete sweep to the seeding path.
--
--    The marker is what makes "daily" mean *at most once per period* rather
--    than *once per timer tick*. App Runner runs this service on the default
--    autoscaling configuration (MinSize 1, MaxSize 25) with
--    `auto_deployments_enabled`, so the process restarts on every merge to
--    master and a naive per-process interval would either never fire or fire on
--    every instance at once.
--
-- The index on `created_at` is what both retention passes scan by. The kitchen
-- board's `order by created_at desc` gets it for free.
ALTER TABLE "orders" ADD COLUMN "personal_data_erased_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retention_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders" ("created_at");
