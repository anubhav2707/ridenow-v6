import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  doublePrecision,
} from 'drizzle-orm/pg-core';

// Minimal founding schema. Feature stories extend this (drivers, quotes,
// trips, payments, earnings) and add PostGIS geometry columns for geo.
export const rides = pgTable('rides', {
  id: uuid('id').primaryKey().defaultRandom(),
  riderPhone: text('rider_phone').notNull(),
  quoteId: uuid('quote_id'),
  driverId: uuid('driver_id'),
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
  quoteId: uuid('quote_id').notNull(),
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

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  rideId: uuid('ride_id').notNull(),
  gateway: text('gateway').notNull().default('fake'),
  intentId: text('intent_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  rideId: uuid('ride_id'),
  driverId: uuid('driver_id'),
  account: text('account').notNull(),
  direction: text('direction').notNull(),
  amountCents: integer('amount_cents').notNull(),
  entryGroupId: uuid('entry_group_id').notNull(),
  kind: text('kind').notNull(),
  memo: text('memo').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
