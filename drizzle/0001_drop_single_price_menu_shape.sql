CREATE TABLE IF NOT EXISTS "allergen_legend" (
	"code" text PRIMARY KEY NOT NULL,
	"label_de" text NOT NULL,
	"label_en" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menu_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"label_en" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menu_item_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"price_cents" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "menu_items" ALTER COLUMN "description" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "variant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "variant_label" text NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_item_variants_item_id_idx" ON "menu_item_variants" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "menu_item_variants_item_id_label_unique" ON "menu_item_variants" USING btree ("item_id","label");--> statement-breakpoint
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "category";--> statement-breakpoint
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "price";--> statement-breakpoint
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "vegetarian";--> statement-breakpoint
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "spicy";