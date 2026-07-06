import { and, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import {
  drivers,
  ledgerEntries,
  payments,
  quoteComponents,
  quotes,
  rides,
} from '../db/schema';
import type {
  LedgerDirection,
  LedgerEntryRow,
  LedgerPosting,
} from '../ledger/ledger.types';
import {
  type DriverRow,
  type PaymentRow,
  type PaymentStatus,
  type QuoteComponentRow,
  type QuoteRow,
  type QuoteStatus,
  type RideRepository,
  type RideRow,
  type RideStatus,
} from './repository';

type Db = typeof defaultDb;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Postgres-backed RideRepository (selected when STORE=postgres). The three
 * persist* methods run inside db.transaction so ride state, the payment row,
 * and the append-only ledger advance together or not at all.
 */
export class DrizzleRideRepository implements RideRepository {
  constructor(private readonly db: Db = defaultDb) {}

  async insertQuote(
    quote: QuoteRow,
    components: QuoteComponentRow[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(quotes).values(quote);
      if (components.length > 0) {
        await tx.insert(quoteComponents).values(components);
      }
    });
  }

  async getQuote(
    id: string,
  ): Promise<{ quote: QuoteRow; components: QuoteComponentRow[] } | null> {
    const [row] = await this.db
      .select()
      .from(quotes)
      .where(eq(quotes.id, id));
    if (!row) return null;
    const componentRows = await this.db
      .select()
      .from(quoteComponents)
      .where(eq(quoteComponents.quoteId, id));
    return {
      quote: mapQuote(row),
      components: componentRows
        .map(mapQuoteComponent)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    };
  }

  async upsertDriver(driver: DriverRow): Promise<DriverRow> {
    const existing = await this.getDriverByPhone(driver.phone);
    if (existing) return existing;
    const [row] = await this.db.insert(drivers).values(driver).returning();
    return mapDriver(row);
  }

  async getDriver(id: string): Promise<DriverRow | null> {
    const [row] = await this.db
      .select()
      .from(drivers)
      .where(eq(drivers.id, id));
    return row ? mapDriver(row) : null;
  }

  async getDriverByPhone(phone: string): Promise<DriverRow | null> {
    const [row] = await this.db
      .select()
      .from(drivers)
      .where(eq(drivers.phone, phone));
    return row ? mapDriver(row) : null;
  }

  async getRide(id: string): Promise<RideRow | null> {
    const [row] = await this.db.select().from(rides).where(eq(rides.id, id));
    return row ? mapRide(row) : null;
  }

  async updateRide(id: string, patch: Partial<RideRow>): Promise<RideRow> {
    const [row] = await this.db
      .update(rides)
      .set(patch)
      .where(eq(rides.id, id))
      .returning();
    return mapRide(row);
  }

  async persistAuthorization(input: {
    quoteId: string;
    ride: RideRow;
    payment: PaymentRow;
    postings: LedgerPosting[];
  }): Promise<RideRow> {
    return this.db.transaction(async (tx) => {
      const [rideRow] = await tx.insert(rides).values(input.ride).returning();
      await tx.insert(payments).values(input.payment);
      // Idempotent posting: a replayed money step conflicts on
      // (ride_id, kind, account) and is skipped rather than doubling the ledger.
      await tx.insert(ledgerEntries).values(input.postings).onConflictDoNothing();
      await tx
        .update(quotes)
        .set({ status: 'consumed' })
        .where(eq(quotes.id, input.quoteId));
      return mapRide(rideRow);
    });
  }

  async persistCapture(input: {
    rideId: string;
    ridePatch: Partial<RideRow>;
    paymentPatch: Partial<PaymentRow>;
    postings: LedgerPosting[];
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(rides)
        .set(input.ridePatch)
        .where(eq(rides.id, input.rideId));
      await tx
        .update(payments)
        .set(input.paymentPatch)
        .where(eq(payments.rideId, input.rideId));
      // A retried completion re-runs these inserts; the unique
      // (ride_id, kind, account) key makes the second attempt a no-op instead
      // of doubling the driver's take-home.
      await tx.insert(ledgerEntries).values(input.postings).onConflictDoNothing();
    });
  }

  async persistVoid(input: {
    rideId: string;
    ridePatch: Partial<RideRow>;
    paymentPatch: Partial<PaymentRow>;
    postings: LedgerPosting[];
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(rides)
        .set(input.ridePatch)
        .where(eq(rides.id, input.rideId));
      await tx
        .update(payments)
        .set(input.paymentPatch)
        .where(eq(payments.rideId, input.rideId));
      // Same idempotency guard as capture: a replayed cancel cannot post the
      // reversing group twice.
      await tx.insert(ledgerEntries).values(input.postings).onConflictDoNothing();
    });
  }

  async getPaymentByRide(rideId: string): Promise<PaymentRow | null> {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.rideId, rideId));
    return row ? mapPayment(row) : null;
  }

  async ledgerForRide(rideId: string): Promise<LedgerEntryRow[]> {
    const rows = await this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.rideId, rideId));
    return rows.map(mapLedgerEntry);
  }

  async ledgerForDriver(driverId: string): Promise<LedgerEntryRow[]> {
    const rows = await this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.driverId, driverId));
    return rows.map(mapLedgerEntry);
  }

  async completedRidesForRider(
    riderPhone: string,
    region: string,
  ): Promise<RideRow[]> {
    const rows = await this.db
      .select()
      .from(rides)
      .where(
        and(
          eq(rides.riderPhone, riderPhone),
          eq(rides.region, region),
          eq(rides.status, 'completed'),
        ),
      );
    return rows.map(mapRide);
  }

  async completedRidesForDriver(
    driverId: string,
    region: string,
  ): Promise<RideRow[]> {
    const rows = await this.db
      .select()
      .from(rides)
      .where(
        and(
          eq(rides.driverId, driverId),
          eq(rides.region, region),
          eq(rides.status, 'completed'),
        ),
      );
    return rows.map(mapRide);
  }
}

function mapQuote(row: Row): QuoteRow {
  return { ...(row as QuoteRow), status: row.status as QuoteStatus };
}

function mapQuoteComponent(row: Row): QuoteComponentRow {
  return row as QuoteComponentRow;
}

function mapDriver(row: Row): DriverRow {
  return row as DriverRow;
}

function mapRide(row: Row): RideRow {
  return { ...(row as RideRow), status: row.status as RideStatus };
}

function mapPayment(row: Row): PaymentRow {
  return { ...(row as PaymentRow), status: row.status as PaymentStatus };
}

function mapLedgerEntry(row: Row): LedgerEntryRow {
  return {
    ...(row as LedgerEntryRow),
    direction: row.direction as LedgerDirection,
  };
}
