CREATE TABLE IF NOT EXISTS "menu_items" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"price" integer NOT NULL,
	"image_url" text,
	"vegetarian" boolean DEFAULT false NOT NULL,
	"spicy" boolean DEFAULT false NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"menu_item_id" text NOT NULL,
	"name" text NOT NULL,
	"unit_price" integer NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"subtotal" integer NOT NULL,
	"delivery_fee" integer NOT NULL,
	"total" integer NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"customer_name" text,
	"customer_phone" text,
	"customer_address" text,
	"customer_notes" text,
	"payment_provider" text,
	"payment_reference" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
