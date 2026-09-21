-- D3: `GET /api/orders/:id` stops handing the customer block to anyone who
-- holds the order link. The order id stays an identifier; this column is the
-- capability.
--
-- Added nullable, backfilled, then made NOT NULL, so the migration is safe on a
-- table that already has rows. The backfill uses `gen_random_uuid()` — built in
-- since Postgres 13, so no `pgcrypto` extension is needed (creating one needs
-- privileges the deploy role may not have on Aurora). Two v4 UUIDs, hyphens
-- stripped, is 244 bits of CSPRNG randomness in 64 hex characters. Those
-- backfilled tokens are never handed to a client: pre-existing orders have no
-- device holding a token, so their reads fall to the redacted shape. The
-- backfill exists to satisfy NOT NULL, not to re-grant access.
--
-- Tokens minted from here on come from `newOrderAccessToken()` in
-- `src/lib/order-service.ts` — 32 bytes of Node CSPRNG, base64url.
--
-- NOTE ON THE INDEX 0005: this migration is deliberately numbered 0006, leaving
-- 0005 free for `0005_shop_facts.sql` on the open backend#22, which this plan
-- declares as its base. Applying order comes from `meta/_journal.json`, not the
-- filename, so the gap is inert on a database that never sees 0005.
--
-- ⚠️ BUT THE `when` IS NOT INERT, AND WHICHEVER BRANCH MERGES SECOND MUST BE
-- RE-STAMPED.
--
-- drizzle's migrator reads only the NEWEST applied row and applies every
-- journal entry whose `when` is strictly greater:
--
--     select ... order by created_at desc limit 1
--     if (!last || Number(last.created_at) < migration.folderMillis) apply
--         -- drizzle-orm/pg-core/dialect.js
--
-- backend#22's `0005_shop_facts` carries `when: 1789855087555`, which is LESS
-- than this file's. So on a database that has already applied 0006/0007, #22's
-- 0005 fails that test and is **silently skipped** — no error, and
-- `shop_profile`'s legal columns never appear. No choice of `when` survives
-- both merge orders: lowering ours breaks the other direction identically.
--
-- So: **whichever of backend#22 and this branch merges SECOND must renumber
-- its migration to the next free index and re-stamp its journal `when` to a
-- value greater than everything already in the journal.** If #22 lands second,
-- `0005_shop_facts` becomes `0008_shop_facts` with a fresh `when`.
ALTER TABLE "orders" ADD COLUMN "access_token" text;
--> statement-breakpoint
UPDATE "orders"
SET "access_token" =
  replace(gen_random_uuid()::text, '-', '') ||
  replace(gen_random_uuid()::text, '-', '')
WHERE "access_token" IS NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "access_token" SET NOT NULL;
