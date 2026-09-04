-- Legacy rows predate categories/variants entirely (no category_id to
-- backfill to) and are wholesale-replaced by seedMenu() on every boot anyway
-- (see seed.ts) — order_lines keeps its own plain-text snapshot of item name/
-- price, not a FK, so historical orders are unaffected by clearing this table.
DELETE FROM "menu_items";--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "number" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "name_en" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "description_en" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "category_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "allergen_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_menu_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
