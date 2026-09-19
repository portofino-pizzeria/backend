CREATE TABLE IF NOT EXISTS "dataset_seeds" (
	"name" text PRIMARY KEY NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL
);
