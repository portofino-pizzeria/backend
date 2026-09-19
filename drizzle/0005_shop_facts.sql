CREATE TABLE IF NOT EXISTS "admin_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_profile" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"street" text NOT NULL,
	"postal_code" text NOT NULL,
	"city" text NOT NULL,
	"phone_display" text NOT NULL,
	"phone_e164" text NOT NULL,
	"email" text,
	"delivery_until" text NOT NULL,
	"holiday_open" text NOT NULL,
	"holiday_close" text NOT NULL,
	"ruhetag_beats_holiday" boolean DEFAULT true NOT NULL,
	"legal_owner_name" text,
	"legal_form" text,
	"vat_id" text,
	"register_court" text,
	"register_number" text,
	"legal_confirmed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_profile_singleton" CHECK ("shop_profile"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_special_days" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text,
	"month_day" text,
	"closed" boolean DEFAULT false NOT NULL,
	"open" text,
	"close" text,
	"delivery_until" text,
	"note" text DEFAULT '' NOT NULL,
	"confirmed" boolean DEFAULT true NOT NULL,
	CONSTRAINT "shop_special_days_date_xor_month_day" CHECK (("shop_special_days"."date" is null) <> ("shop_special_days"."month_day" is null)),
	CONSTRAINT "shop_special_days_open_needs_close" CHECK ("shop_special_days"."closed" or ("shop_special_days"."close" is not null and ("shop_special_days"."open" is not null or "shop_special_days"."month_day" is not null)))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shop_weekly_hours" (
	"weekday" integer PRIMARY KEY NOT NULL,
	"open" text,
	"close" text,
	CONSTRAINT "shop_weekly_hours_weekday_range" CHECK ("shop_weekly_hours"."weekday" between 1 and 7),
	CONSTRAINT "shop_weekly_hours_both_or_neither" CHECK (("shop_weekly_hours"."open" is null) = ("shop_weekly_hours"."close" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_special_days_date_unique" ON "shop_special_days" USING btree ("date") WHERE "shop_special_days"."date" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shop_special_days_month_day_unique" ON "shop_special_days" USING btree ("month_day") WHERE "shop_special_days"."month_day" is not null;