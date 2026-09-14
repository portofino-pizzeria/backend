ALTER TABLE "menu_items" ADD COLUMN "pickup_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfilment" text DEFAULT 'delivery' NOT NULL;