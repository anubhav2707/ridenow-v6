import { getTableConfig } from 'drizzle-orm/pg-core';
import { rides, drivers, gpsPings } from './schema';

// Pins the SCRUM-241 driver-flow schema shape (proven without a live DB via
// getTableConfig): the OTP/offer/GPS ride columns, the onboarding driver
// columns, and the gps_pings table with its idempotency guard. A stray type or
// default change fails here instead of in production.

type AnyPgTable = Parameters<typeof getTableConfig>[0];

function column(table: AnyPgTable, name: string) {
  const c = getTableConfig(table).columns.find((col) => col.name === name);
  if (!c) {
    throw new Error(
      `expected column "${name}" on table "${getTableConfig(table).name}"`,
    );
  }
  return c;
}

function uniqueColumnSets(table: AnyPgTable): string[][] {
  return getTableConfig(table).uniqueConstraints.map((u) =>
    u.columns.map((col) => col.name),
  );
}

function hasUniqueOn(table: AnyPgTable, cols: string[]): boolean {
  return uniqueColumnSets(table).some(
    (set) => set.length === cols.length && cols.every((c) => set.includes(c)),
  );
}

describe('rides -- offered/OTP/in-progress driver state machine', () => {
  it('carries a pickup snapshot as double-precision coordinates', () => {
    for (const name of ['pickup_lat', 'pickup_lng', 'last_lat', 'last_lng']) {
      expect(column(rides, name).getSQLType()).toBe('double precision');
      expect(column(rides, name).notNull).toBe(false);
    }
  });

  it('tracks OTP attempts as a non-null integer defaulting to 0', () => {
    const attempts = column(rides, 'otp_attempts');
    expect(attempts.getSQLType()).toBe('integer');
    expect(attempts.notNull).toBe(true);
    expect(attempts.default).toBe(0);
  });

  it('keeps the OTP/offer/trip lifecycle stamps nullable and timezone-aware', () => {
    for (const name of [
      'offer_expires_at',
      'otp_expires_at',
      'otp_consumed_at',
      'started_at',
      'last_ping_at',
    ]) {
      const ts = column(rides, name);
      expect(ts.getSQLType()).toBe('timestamp with time zone');
      expect(ts.notNull).toBe(false);
    }
    expect(column(rides, 'otp_code').getSQLType()).toBe('text');
  });
});

describe('drivers -- lightweight onboarding', () => {
  it('stores vehicle details and the chosen flat-fee plan', () => {
    for (const name of [
      'vehicle_make',
      'vehicle_model',
      'vehicle_plate',
      'plan',
    ]) {
      expect(column(drivers, name).getSQLType()).toBe('text');
    }
  });

  it('keeps the subscription fee as non-null integer cents (never a percentage)', () => {
    const fee = column(drivers, 'subscription_fee_cents');
    expect(fee.getSQLType()).toBe('integer');
    expect(fee.notNull).toBe(true);
    expect(fee.default).toBe(0);
  });

  it('gates eligibility on a non-null active flag (default false)', () => {
    const active = column(drivers, 'active');
    expect(active.getSQLType()).toBe('boolean');
    expect(active.notNull).toBe(true);
    expect(active.default).toBe(false);
  });
});

describe('gps_pings -- append-only, idempotent trip fixes', () => {
  it('is named "gps_pings" with a generated uuid primary key', () => {
    expect(getTableConfig(gpsPings).name).toBe('gps_pings');
    const id = column(gpsPings, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
  });

  it('requires ride linkage, coordinates, a client timestamp and a seq', () => {
    expect(column(gpsPings, 'ride_id').notNull).toBe(true);
    for (const name of ['lat', 'lng']) {
      expect(column(gpsPings, name).getSQLType()).toBe('double precision');
      expect(column(gpsPings, name).notNull).toBe(true);
    }
    expect(column(gpsPings, 'recorded_at').getSQLType()).toBe(
      'timestamp with time zone',
    );
    expect(column(gpsPings, 'recorded_at').notNull).toBe(true);
    expect(column(gpsPings, 'received_at').hasDefault).toBe(true);
    expect(column(gpsPings, 'seq').getSQLType()).toBe('integer');
    expect(column(gpsPings, 'seq').notNull).toBe(true);
  });

  it('makes a re-sent ping a conflict via UNIQUE(ride_id, seq)', () => {
    expect(hasUniqueOn(gpsPings, ['ride_id', 'seq'])).toBe(true);
  });

  it('references a real ride, restrict on delete', () => {
    const fk = getTableConfig(gpsPings).foreignKeys.map((f) => {
      const ref = f.reference();
      return {
        foreignTable: getTableConfig(ref.foreignTable).name,
        onDelete: f.onDelete,
      };
    })[0];
    expect(fk?.foreignTable).toBe('rides');
    expect(fk?.onDelete).toBe('restrict');
  });
});
