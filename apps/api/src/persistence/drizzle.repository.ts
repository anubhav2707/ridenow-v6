import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import {
  drivers,
  gpsPings,
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
  type GpsPingRow,
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

  async acceptOffer(input: {
    rideId: string;
    driverId: string;
    now: Date;
    otpCode: string;
    otpExpiresAt: Date;
  }): Promise<RideRow | null> {
    // Single atomic compare-and-set: only the row still in 'offered', driverless
    // and unexpired is updated + RETURNed. Concurrent accepts serialize on the
    // row lock, so the second sees status='accepted' and matches nothing.
    const [row] = await this.db
      .update(rides)
      .set({
        driverId: input.driverId,
        status: 'accepted',
        acceptedAt: input.now,
        otpCode: input.otpCode,
        otpExpiresAt: input.otpExpiresAt,
        otpAttempts: 0,
        otpConsumedAt: null,
      })
      .where(
        and(
          eq(rides.id, input.rideId),
          eq(rides.status, 'offered'),
          isNull(rides.driverId),
          or(
            isNull(rides.offerExpiresAt),
            gt(rides.offerExpiresAt, input.now),
          ),
        ),
      )
      .returning();
    return row ? mapRide(row) : null;
  }

  async recordPing(input: {
    rideId: string;
    lat: number;
    lng: number;
    recordedAt: Date;
    receivedAt: Date;
  }): Promise<GpsPingRow> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ seq: gpsPings.seq })
        .from(gpsPings)
        .where(eq(gpsPings.rideId, input.rideId));
      const seq =
        existing.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
      const [inserted] = await tx
        .insert(gpsPings)
        .values({
          id: randomUUID(),
          rideId: input.rideId,
          lat: input.lat,
          lng: input.lng,
          recordedAt: input.recordedAt,
          receivedAt: input.receivedAt,
          seq,
        })
        .returning();
      await tx
        .update(rides)
        .set({
          lastLat: input.lat,
          lastLng: input.lng,
          lastPingAt: input.recordedAt,
        })
        .where(eq(rides.id, input.rideId));
      return mapGpsPing(inserted);
    });
  }

  async pingsForRide(rideId: string): Promise<GpsPingRow[]> {
    const rows = await this.db
      .select()
      .from(gpsPings)
      .where(eq(gpsPings.rideId, rideId));
    return rows.map(mapGpsPing).sort((a, b) => a.seq - b.seq);
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

function mapGpsPing(row: Row): GpsPingRow {
  return row as GpsPingRow;
}