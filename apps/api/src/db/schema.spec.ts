import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  rides,
  quotes,
  quoteComponents,
  drivers,
  payments,
  ledgerEntries,
} from './schema';

// A Drizzle table is a plain object, so the schema can be proven without a
// live database: getTableConfig exposes each column's SQL type, nullability,
// default and uniqueness. These tests pin the shape SCRUM-243 relies on -- the
// paid-ride lifecycle, the rider's fare breakdown, and the payment/earnings
// money fields -- so an accidental type or default change fails here instead
// of in production. (Integrity constraints -- FKs, idempotency uniques --
// are pinned separately in schema.constraints.spec.ts.)

type AnyPgTable = Parameters<typeof getTableConfig>[0];

function columnsByName(table: AnyPgTable) {
  const { columns } = getTableConfig(table);
  return new Map(columns.map((c) => [c.name, c]));
}

function column(table: AnyPgTable, name: string) {
  const c = columnsByName(table).get(name);
  if (!c) {
    throw new Error(
      `expected column "${name}" on table "${getTableConfig(table).name}"`,
    );
  }
  return c;
}

describe('rides table -- paid-ride lifecycle', () => {
  it('is named "rides" and has a generated uuid primary key', () => {
    expect(getTableConfig(rides).name).toBe('rides');
    const id = column(rides, 'id');
    expect(id.getSQLType()).toBe('uuid');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true); // defaultRandom()
  });

  it('defaults a fresh ride to an unpaid "quoted" usd fare of 0 cents', () => {
    const status = column(rides, 'status');
    expect(status.notNull).toBe(true);
    expect(status.default).toBe('quoted');

    const fare = column(rides, 'fare_cents');
    expect(fare.getSQLType()).toBe('integer');
    expect(fare.notNull).toBe(true);
    expect(fare.default).toBe(0);

    const currency = column(rides, 'currency');
    expect(currency.notNull).toBe(true);
    expect(currency.default).toBe('usd');
  });

  it('carries every lifecycle timestamp as a nullable timezone-aware column', () => {
    // These stamps are unset until the ride reaches each stage, so none may be
    // NOT NULL -- otherwise a freshly quoted ride could never be inserted.
    for (const name of [
      'authorized_at',
      'accepted_at',
      'completed_at',
      'cancelled_at',
    ]) {
      const ts = column(rides, name);
      expect(ts.getSQLType()).toBe('timestamp with time zone');
      expect(ts.notNull).toBe(false);
    }
    const createdAt = column(rides, 'created_at');
    expect(createdAt.notNull).toBe(true);
    expect(createdAt.hasDefault).toBe(true); // defaultNow()
  });

  it('requires the rider phone every ride is booked against', () => {
    expect(column(rides, 'rider_phone').notNull).toBe(true);
  });
});

describe('money is integer cents, geo is double precision', () => {
  // The single most damaging schema mistake here would be storing money as a
  // float and losing cents to rounding. Every "*_cents" column must be an
  // integer; only the lat/lng coordinates may be double precision.
  const centColumns = [
    { label: 'rides.fare_cents', table: rides, name: 'fare_cents' },
    { label: 'quotes.total_cents', table: quotes, name: 'total_cents' },
    {
      label: 'quote_components.amount_cents',
      table: quoteComponents,
      name: 'amount_cents',
    },
    { label: 'payments.amount_cents', table: payments, name: 'amount_cents' },
  ];

  it.each(centColumns)('stores $label as integer cents', ({ table, name }) => {
    expect(column(table, name).getSQLType()).toBe('integer');
  });

  it('keeps pickup/dropoff coordinates as double precision, not integers', () => {
    for (const name of [
      'pickup_lat',
      'pickup_lng',
      'dropoff_lat',
      'dropoff_lng',
    ]) {
      expect(column(quotes, name).getSQLType()).toBe('double precision');
    }
  });
});

describe('quote fare breakdown -- rider fare math', () => {
  it('requires the aggregate quote totals used to build the fare', () => {
    for (const name of ['total_cents', 'distance_meters', 'duration_seconds']) {
      const c = column(quotes, name);
      expect(c.getSQLType()).toBe('integer');
      expect(c.notNull).toBe(true);
    }
    expect(column(quotes, 'currency').default).toBe('usd');
    expect(column(quotes, 'status').default).toBe('active');
  });

  it('requires every line item of the breakdown, ordered for display', () => {
    for (const name of [
      'quote_id',
      'kind',
      'label',
      'amount_cents',
      'sort_order',
    ]) {
      expect(column(quoteComponents, name).notNull).toBe(true);
    }
    expect(column(quoteComponents, 'sort_order').getSQLType()).toBe('integer');
  });
});

describe('payments -- idempotent charging (no double-charge path)', () => {
  it('makes the idempotency key a required unique guard', () => {
    const key = column(payments, 'idempotency_key');
    expect(key.notNull).toBe(true);
    expect(key.isUnique).toBe(true);
  });

  it('requires ride linkage, intent id and status, and defaults gateway/currency', () => {
    expect(column(payments, 'ride_id').notNull).toBe(true);
    expect(column(payments, 'intent_id').notNull).toBe(true);
    expect(column(payments, 'status').notNull).toBe(true);
    expect(column(payments, 'gateway').default).toBe('fake');
    expect(column(payments, 'currency').default).toBe('usd');
  });
});

describe('drivers & earnings ledger -- driver take-home', () => {
  it('makes a driver phone unique so a subscription maps one-to-one', () => {
    const phone = column(drivers, 'phone');
    expect(phone.notNull).toBe(true);
    expect(phone.isUnique).toBe(true);
    expect(column(drivers, 'subscription_status').default).toBe('active');
  });

  it('links ledger entries back to a ride and a driver', () => {
    // Earnings fan out per ride/driver, so both keys must exist on the ledger.
    expect(column(ledgerEntries, 'ride_id').getSQLType()).toBe('uuid');
    expect(column(ledgerEntries, 'driver_id').getSQLType()).toBe('uuid');
  });
});
