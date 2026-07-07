import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  doublePrecision,
  boolean,
  index,
  unique,
} from 'drizzle-orm/pg-core';

// Minimal founding schema. Feature stories extend this (drivers, quotes,
// trips, payments, earnings) and add PostGIS geometry columns for geo.
//
// SCRUM-241 grows `rides` into the full driver-facing state machine
// (quoted -> offered -> accepted -> in_progress -> completed) and adds the OTP
// trip-start, GPS ping, and take-home fields the driver loop needs. All new
// columns are nullable / defaulted so the existing paid-ride flow keeps working.
export const rides = pgTable(
  'rides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderPhone: text('rider_phone').notNull(),
    // Reference columns carry real FKs so a ride can never point at a quote or
    // driver that does not exist; restrict blocks deleting a referenced row.
    quoteId: uuid('quote_id').references(() => quotes.id, {
      onDelete: 'restrict',
    }),
    driverId: uuid('driver_id').references(() => drivers.id, {
      onDelete: 'restrict',
    }),
    region: text('region').notNull().default('geo-1'),
    status: text('status').notNull().default('quoted'),
    fareCents: integer('fare_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    paymentIntentId: text('payment_intent_id'),
    // Pickup snapshot copied from the locked quote so an "offered" ride carries
    // its own pickup location without re-reading the quote.
    pickupLabel: text('pickup_label'),
    pickupLat: doublePrecision('pickup_lat'),
    pickupLng: doublePrecision('pickup_lng'),
    // How long the ride stays claimable by a driver.
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }),
    // OTP trip-start. The plaintext code is stored so the rider app can display
    // it for the rider to read aloud (no push channel / auth in this MVP); it is
    // short-TTL, attempt-limited, single-use, and cleared the moment it is
    // consumed. It is never returned on any driver-facing view.
    otpCode: text('otp_code'),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    otpConsumedAt: timestamp('otp_consumed_at', { withTimezone: true }),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    // Hot "latest position" for the in-progress trip (off the money path).
    lastLat: doublePrecision('last_lat'),
    lastLng: doublePrecision('last_lng'),
    lastPingAt: timestamp('last_ping_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('rides_status_idx').on(t.status)],
);

// SCRUM-240 passwordless rider identity. A rider is just a phone number that
// proved control of an SMS-delivered OTP — there is NO password column anywhere.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  role: text('role').notNull().default('rider'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// One-time SMS login codes. The raw 6-digit code is NEVER stored — only its
// SHA-256 hash — so a DB leak can't be replayed into a login. Codes are
// short-TTL, attempt-limited (lockout after too many wrong guesses), and
// single-use (consumedAt is set the instant a correct code is accepted).
export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('otp_codes_phone_created_idx').on(t.phone, t.createdAt)],
);

// Refresh-token sessions. Only the SHA-256 hash of the rotating refresh token is
// stored; presenting the token proves possession without the server ever holding
// a replayable secret. Rotation revokes the old row and issues a new one in one
// transaction, so a refresh token is strictly single-use.
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    role: text('role').notNull().default('rider'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// Tokenized cards saved by a rider. Card data is tokenized client-side via Stripe
// Elements (SAQ-A); only the opaque Stripe payment_method / customer ids and
// display-safe brand/last4 ever reach this table. Exactly one row per user is the
// default, used to authorize the next ride with no re-entry of card details.
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id'),
    stripePaymentMethodId: text('stripe_payment_method_id').notNull(),
    brand: text('brand'),
    last4: text('last4'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('payment_methods_user_idx').on(t.userId),
    // One saved token maps to one row; a re-save of the same token conflicts
    // instead of stacking duplicate cards for the rider.
    unique('payment_methods_user_pm_unique').on(t.userId, t.stripePaymentMethodId),
  ],
);

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  riderPhone: text('rider_phone').notNull(),
  region: text('region').notNull(),
  pickupLabel: text('pickup_label').notNull(),
  pickupLat: doublePrecision('pickup_lat').notNull(),
  pickupLng: doublePrecision('pickup_lng').notNull(),
  dropoffLabel: text('dropoff_label').notNull(),
  dropoffLat: doublePrecision('dropoff_lat').notNull(),
  dropoffLng: doublePrecision('dropoff_lng').notNull(),
  distanceMeters: integer('distance_meters').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  currency: text('currency').notNull().default('usd'),
  totalCents: integer('total_cents').notNull(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const quoteComponents = pgTable('quote_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Line items belong to their quote; cascade so they never outlive it.
  quoteId: uuid('quote_id')
    .notNull()
    .references(() => quotes.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  amountCents: integer('amount_cents').notNull(),
  sortOrder: integer('sort_order').notNull(),
});

export const drivers = pgTable(
  'drivers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull().unique(),
    displayName: text('display_name').notNull(),
    region: text('region').notNull(),
    subscriptionStatus: text('subscription_status').notNull().default('active'),
    // SCRUM-241 lightweight onboarding: vehicle details + the chosen flat-fee
    // subscription plan. `active` gates eligibility to receive ride offers and
    // is set true at onboarding with NO automated KYC gate.
    vehicleMake: text('vehicle_make'),
    vehicleModel: text('vehicle_model'),
    vehiclePlate: text('vehicle_plate'),
    plan: text('plan'),
    subscriptionFeeCents: integer('subscription_fee_cents').notNull().default(0),
    active: boolean('active').notNull().default(false),
    // SCRUM-242 dispatch-lite proximity. A driver's last self-reported position,
    // used only to RANK nearby available drivers for one-click operator assign.
    // Plain lat/lng doubles (haversine-ranked) keep CI/tests hermetic; production
    // may later promote these to a PostGIS geometry(Point,4326) + GiST/KNN index
    // (the image is postgis-enabled) without changing this feature's contract.
    lastLat: doublePrecision('last_lat'),
    lastLng: doublePrecision('last_lng'),
    lastLocationAt: timestamp('last_location_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('drivers_active_idx').on(t.active),
    // Ranking source: available drivers are looked up by (region, active); the
    // proximity sort runs in the service over the last-known coordinates.
    index('drivers_region_active_idx').on(t.region, t.active),
  ],
);

// GPS pings for an in-progress trip. Deliberately off the money path: a ping is
// an append-only (ride_id, lat, lng, timestamp) fact plus a per-ride monotonic
// seq. UNIQUE(ride_id, seq) makes a re-sent ping conflict instead of duplicating.
export const gpsPings = pgTable(
  'gps_pings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rideId: uuid('ride_id')
      .notNull()
      .references(() => rides.id, { onDelete: 'restrict' }),
    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    // Client-reported time the fix was taken.
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    // Server-authoritative time the ping was persisted.
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    seq: integer('seq').notNull(),
  },
  (t) => [
    index('gps_pings_ride_recorded_idx').on(t.rideId, t.recordedAt),
    unique('gps_pings_ride_seq_unique').on(t.rideId, t.seq),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rideId: uuid('ride_id')
      .notNull()
      .references(() => rides.id, { onDelete: 'restrict' }),
    gateway: text('gateway').notNull().default('fake'),
    intentId: text('intent_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('usd'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set at insert, then refreshed on every UPDATE via the ORM hook below AND a
    // DB trigger (see migration) so audit/reconciliation queries see the real
    // last-modified time, not the creation time.
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [
    // One gateway charge maps to exactly one payments row: idempotency_key stops
    // a replayed request, this stops the same intent being recorded twice under
    // two different keys (double-counted revenue).
    unique('payments_gateway_intent_id_unique').on(t.gateway, t.intentId),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The ledger is the money source of truth, so every ride-scoped leg must
    // attribute to a real ride. driverId stays nullable for platform-account
    // legs (cash, hold, rider receivable) that are intentionally driverless.
    rideId: uuid('ride_id')
      .notNull()
      .references(() => rides.id, { onDelete: 'restrict' }),
    driverId: uuid('driver_id').references(() => drivers.id, {
      onDelete: 'restrict',
    }),
    account: text('account').notNull(),
    direction: text('direction').notNull(),
    amountCents: integer('amount_cents').notNull(),
    entryGroupId: uuid('entry_group_id').notNull(),
    kind: text('kind').notNull(),
    memo: text('memo').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('ledger_entries_driver_created_idx').on(t.driverId, t.createdAt),
    // Idempotent posting key: re-running a ride's ledger group (double-tap,
    // client retry, at-least-once webhook redelivery) conflicts instead of
    // duplicating, so driver take-home can never be inflated. Each (kind,
    // account) pair occurs at most once across a ride's auth/capture/void
    // groups, which makes (ride_id, kind, account) a safe idempotency key.
    unique('ledger_entries_ride_kind_account_unique').on(
      t.rideId,
      t.kind,
      t.account,
    ),
  ],
);