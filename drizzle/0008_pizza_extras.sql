-- Extra ingredients ("Zutaten") a diner can add to a dish, priced per size.
--
-- `menu_extras` holds the ingredient and its allergen codes; `menu_extra_prices`
-- holds one price per size, keyed by the variant label the dishes already carry
-- ("klein 22cm", "groß 28cm", "Blech 30x50cm"). A size with no price row means
-- the extra is not offered on that size — never that it is free.
--
-- `order_lines.extras` snapshots the extras on a line (id, name, price) the way
-- the line already snapshots its name and price, so an edited or deleted extra
-- never rewrites a past order. `unit_price` keeps meaning "one unit, all in".
--
-- Nothing is seeded into `menu_extras`: Portofino's menu publishes no extras
-- prices, and the owner enters them. The Pizza category is switched on below
-- for a database that already holds the menu; a fresh one gets the same flag
-- from `seedMenu()`.
CREATE TABLE IF NOT EXISTS "menu_extra_prices" (
	"extra_id" text NOT NULL,
	"size_label" text NOT NULL,
	"price_cents" integer NOT NULL,
	CONSTRAINT "menu_extra_prices_extra_id_size_label_pk" PRIMARY KEY("extra_id","size_label"),
	CONSTRAINT "menu_extra_prices_positive" CHECK ("menu_extra_prices"."price_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menu_extras" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_en" text,
	"allergen_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_categories" ADD COLUMN "offers_extras" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "extras" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "menu_extra_prices" ADD CONSTRAINT "menu_extra_prices_extra_id_menu_extras_id_fk" FOREIGN KEY ("extra_id") REFERENCES "public"."menu_extras"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
UPDATE "menu_categories" SET "offers_extras" = true WHERE "id" = 'pizza';
