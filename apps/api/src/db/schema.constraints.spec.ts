import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  rides,
  quotes,
  quoteComponents,
  drivers,
  payments,
  ledgerEntries,
} from './schema';

// The money-critical integrity guards SCRUM-243 relies on live in the schema:
// foreign keys so financial rows can't be orphaned, UNIQUE keys so a charge or a
// ledger group can't be double-recorded, NOT NULL so a ride-scoped ledger leg is
// always attributed, and an $onUpdate hook so payments.updated_at tracks the
// real last-modified time. getTableConfig exposes all of these without a live DB
// -- and unlike schema.test.ts (a stray vitest file the jest runner never
// picks up), this .spec.ts actually executes in CI.

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

interface FkShape {
  localColumns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete: string | undefined;
}

function foreignKeys(table: AnyPgTable): FkShape[] {
  return getTableConfig(table).foreignKeys.map((fk) => {
    const ref = fk.reference();
    return {
      localColumns: ref.columns.map((c) => c.name),
      foreignTable: getTableConfig(ref.foreignTable).name,
      foreignColumns: ref.foreignColumns.map((c) => c.name),
      onDelete: fk.onDelete,
    };
  });
}

function fkOn(table: AnyPgTable, columnName: string): FkShape | undefined {
  return foreignKeys(table).find((fk) => fk.localColumns.includes(columnName));
}

function uniqueColumnSets(table: AnyPgTable): string[][] {
  return getTableConfig(table).uniqueConstraints.map((u) =>
    u.columns.map((c) => c.name),
  );
}

function hasUniqueOn(table: AnyPgTable, cols: string[]): boolean {
  return uniqueColumnSets(table).some(
    (set) =>
      set.length === cols.length && cols.every((c) => set.includes(c)),
  );
}

describe('ledger_entries -- idempotent, attributed, non-orphaned money', () => {
  it('makes ledger posting idempotent via UNIQUE(ride_id, kind, account)', () => {
    // A retried completion (double-tap, client retry, at-least-once webhook)
    // must conflict on this key instead of duplicating and inflating take-home.
    expect(hasUniqueOn(ledgerEntries, ['ride_id', 'kind', 'account'])).toBe(
      true,
    );
  });

  it('requires a real ride for every ledger leg (ride_id NOT NULL + FK)', () => {
    expect(column(ledgerEntries, 'ride_id').notNull).toBe(true);
    const fk = fkOn(ledgerEntries, 'ride_id');
    expect(fk?.foreignTable).toBe('rides');
    expect(fk?.foreignColumns).toEqual(['id']);
    expect(fk?.onDelete).toBe('restrict');
  });

  it('references a real driver when attributed, but stays nullable for platform legs', () => {
    // cash / hold / rider-receivable legs are intentionally driverless.
    expect(column(ledgerEntries, 'driver_id').notNull).toBe(false);
    const fk = fkOn(ledgerEntries, 'driver_id');
    expect(fk?.foreignTable).toBe('drivers');
    expect(fk?.onDelete).toBe('restrict');
  });
});

describe('payments -- one row per real ride and per real charge', () => {
  it('keeps the idempotency_key unique guard', () => {
    expect(column(payments, 'idempotency_key').isUnique).toBe(true);
  });

  it('maps one gateway intent to exactly one row via UNIQUE(gateway, intent_id)', () => {
    // Stops the same underlying charge being recorded twice under two different
    // idempotency keys (double-counted revenue).
    expect(hasUniqueOn(payments, ['gateway', 'intent_id'])).toBe(true);
  });

  it('references a real ride (ride_id FK, restrict on delete)', () => {
    const fk = fkOn(payments, 'ride_id');
    expect(fk?.foreignTable).toBe('rides');
    expect(fk?.foreignColumns).toEqual(['id']);
    expect(fk?.onDelete).toBe('restrict');
  });

  it('refreshes updated_at on every UPDATE via an $onUpdate hook', () => {
    const updatedAt = column(payments, 'updated_at') as unknown as {
      onUpdateFn?: unknown;
    };
    expect(typeof updatedAt.onUpdateFn).toBe('function');
  });
});

describe('reference columns carry real foreign keys', () => {
  it('links a ride back to its originating quote and assigned driver', () => {
    const quoteFk = fkOn(rides, 'quote_id');
    expect(quoteFk?.foreignTable).toBe('quotes');
    expect(quoteFk?.onDelete).toBe('restrict');

    const driverFk = fkOn(rides, 'driver_id');
    expect(driverFk?.foreignTable).toBe('drivers');
    expect(driverFk?.onDelete).toBe('restrict');
  });

  it('links a quote line item back to its quote (cascade)', () => {
    const fk = fkOn(quoteComponents, 'quote_id');
    expect(fk?.foreignTable).toBe('quotes');
    expect(fk?.onDelete).toBe('cascade');
  });
});
