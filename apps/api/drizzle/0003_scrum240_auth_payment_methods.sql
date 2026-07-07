-- SCRUM-240 rider passwordless auth + saved payment methods. Hand-authored and
-- reviewed. All new tables use CREATE TABLE IF NOT EXISTS so a re-run is a no-op.
--
-- users: phone-only rider identity (NO password column anywhere).
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"role" text DEFAULT 'rider' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);--> statement-breakpoint

-- otp_codes: one-time SMS login codes stored ONLY as a SHA-256 hash, short-TTL,
-- attempt-limited, single-use (consumed_at).
CREATE TABLE IF NOT EXISTS "otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otp_codes_phone_created_idx" ON "otp_codes" ("phone","created_at");--> statement-breakpoint

-- sessions: rotating refresh tokens stored as a SHA-256 hash; revoked_at gates
-- validity so a rotated/revoked token can never be reused.
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"role" text DEFAULT 'rider' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash"),
	CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id");--> statement-breakpoint

-- payment_methods: opaque Stripe token references (SAQ-A; no PAN ever stored).
CREATE TABLE IF NOT EXISTS "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_method_id" text NOT NULL,
	"brand" text,
	"last4" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_user_pm_unique" UNIQUE("user_id","stripe_payment_method_id"),
	CONSTRAINT "payment_methods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_methods_user_idx" ON "payment_methods" ("user_id");
