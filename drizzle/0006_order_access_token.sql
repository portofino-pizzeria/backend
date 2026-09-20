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
ALTER TABLE "orders" ADD COLUMN "access_token" text;
--> statement-breakpoint
UPDATE "orders"
SET "access_token" =
  replace(gen_random_uuid()::text, '-', '') ||
  replace(gen_random_uuid()::text, '-', '')
WHERE "access_token" IS NULL;
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "access_token" SET NOT NULL;
