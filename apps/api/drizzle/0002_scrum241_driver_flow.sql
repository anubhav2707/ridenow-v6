-- SCRUM-241 driver flow: onboarding fields, offer/OTP/GPS ride state, and the
-- gps_pings table. Hand-authored and reviewed: existing tables (rides, drivers)
-- are extended with idempotent ADD COLUMN IF NOT EXISTS; only the genuinely new
-- gps_pings table uses CREATE TABLE.

-- rides: pickup snapshot, offer TTL, OTP trip-start, trip start, hot last-position
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "pickup_label" text;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "pickup_lat" double precision;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "pickup_lng" double precision;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "offer_expires_at" timestamp with time zone;--> statement-breakpoint
-- rides: driver assignment + accept/complete/cancel lifecycle timestamps written by the SCRUM-241 accept/complete/cancel transitions
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "otp_code" text;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "otp_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "otp_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "otp_consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "last_lat" double precision;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "last_lng" double precision;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "last_ping_at" timestamp with time zone;--> statement-breakpoint

-- drivers: lightweight onboarding (vehicle + flat-fee plan + activation)
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "vehicle_make" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "vehicle_model" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "vehicle_plate" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "plan" text;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "subscription_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "active" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- gps_pings: append-only trip location fixes (off the money path)
CREATE TABLE "gps_pings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ride_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "gps_pings_ride_seq_unique" UNIQUE("ride_id","seq"),
	CONSTRAINT "gps_pings_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "rides"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "gps_pings_ride_recorded_idx" ON "gps_pings" ("ride_id","recorded_at");--> statement-breakpoint
CREATE INDEX "rides_status_idx" ON "rides" ("status");--> statement-breakpoint
CREATE INDEX "drivers_active_idx" ON "drivers" ("active");
