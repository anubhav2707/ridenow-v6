import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  doublePrecision,
  index,
  unique,
} from 'drizzle-orm/pg-core';

// Minimal founding schema. Feature stories extend this (drivers, quotes,
// trips, payments, earnings) and add PostGIS geometry columns for geo.
export const rides = pgTable('rides', {
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
  authorizedAt: timestamp('authorized_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

export const drivers = pgTable('drivers', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  displayName: text('display_name').notNull(),
  region: text('region').notNull(),
  subscriptionStatus: text('subscription_status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
