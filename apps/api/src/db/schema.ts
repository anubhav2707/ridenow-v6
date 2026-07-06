import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

// Minimal founding schema. Feature stories extend this (drivers, quotes,
// trips, payments, earnings) and add PostGIS geometry columns for geo.
export const rides = pgTable('rides', {
  id: uuid('id').primaryKey().defaultRandom(),
  riderPhone: text('rider_phone').notNull(),
  status: text('status').notNull().default('quoted'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
