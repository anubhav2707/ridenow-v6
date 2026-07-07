CREATE TABLE "rides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_phone" text NOT NULL,
	"status" text DEFAULT 'quoted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
