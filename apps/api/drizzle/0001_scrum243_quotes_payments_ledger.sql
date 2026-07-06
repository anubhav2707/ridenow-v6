CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rider_phone" text NOT NULL,
	"region" text NOT NULL,
	"pickup_label" text NOT NULL,
	"pickup_lat" double precision NOT NULL,
	"pickup_lng" double precision NOT NULL,
	"dropoff_label" text NOT NULL,
	"dropoff_lat" double precision NOT NULL,
	"dropoff_lng" double precision NOT NULL,
	"distance_meters" integer NOT NULL,
	"duration_seconds" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"total_cents" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "quote_components_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"display_name" text NOT NULL,
	"region" text NOT NULL,
	"subscription_status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ride_id" uuid NOT NULL,
	"gateway" text DEFAULT 'fake' NOT NULL,
	"intent_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payments_gateway_intent_id_unique" UNIQUE("gateway","intent_id"),
	CONSTRAINT "payments_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ride_id" uuid NOT NULL,
	"driver_id" uuid,
	"account" text NOT NULL,
	"direction" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"entry_group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_ride_kind_account_unique" UNIQUE("ride_id","kind","account"),
	CONSTRAINT "ledger_entries_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "ledger_entries_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "quote_id" uuid;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "region" text DEFAULT 'geo-1' NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "fare_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "currency" text DEFAULT 'usd' NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_driver_created_idx" ON "ledger_entries" ("driver_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "payments_set_updated_at" BEFORE UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
