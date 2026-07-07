-- SCRUM-242 dispatch-lite matching: drivers carry a last-known position so the
-- operator console can RANK nearby available drivers for one-click assign.
-- Hand-authored and reviewed: the drivers table is extended with idempotent
-- ADD COLUMN IF NOT EXISTS so re-running is safe. Coordinates are plain doubles
-- (haversine-ranked in the service) which keeps the feature hermetic; the
-- postgis-enabled image leaves room to promote these to geometry(Point,4326)
-- with a GiST/KNN index later without changing the dispatch contract.

ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "last_lat" double precision;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "last_lng" double precision;--> statement-breakpoint
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "last_location_at" timestamp with time zone;--> statement-breakpoint

-- Ranking lookup key: available drivers are selected by (region, active); the
-- nearest-available sort then runs over last_lat/last_lng in the service.
CREATE INDEX IF NOT EXISTS "drivers_region_active_idx" ON "drivers" ("region","active");
