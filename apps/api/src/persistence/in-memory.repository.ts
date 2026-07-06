import { randomUUID } from 'node:crypto';
import type { LedgerEntryRow, LedgerPosting } from '../ledger/ledger.types';
import {
  type DriverRow,
  type PaymentRow,
  type QuoteComponentRow,
  type QuoteRow,
  type RideRepository,
  type RideRow,
} from './repository';

/**
 * In-memory RideRepository used by tests and as the local default store. The
 * persist* methods build every row up front and only then mutate the backing
 * arrays, so a validation failure leaves no partial write — the same all-or-
 * nothing guarantee the Drizzle implementation gets from a DB transaction.
 */
export class InMemoryRideRepository implements RideRepository {
  private readonly quotes = new Map<string, QuoteRow>();
  private readonly quoteComponents = new Map<string, QuoteComponentRow[]>();
  private readonly drivers = new Map<string, DriverRow>();
  private readonly rides = new Map<string, RideRow>();
  private readonly payments = new Map<string, PaymentRow>();
  private readonly ledger: LedgerEntryRow[] = [];
  private ledgerClock = 0;

  async insertQuote(
    quote: QuoteRow,
    components: QuoteComponentRow[],
  ): Promise<void> {
    this.quotes.set(quote.id, { ...quote });
    this.quoteComponents.set(
      quote.id,
      components.map((c) => ({ ...c })),
    );
  }

  async getQuote(
    id: string,
  ): Promise<{ quote: QuoteRow; components: QuoteComponentRow[] } | null> {
    const quote = this.quotes.get(id);
    if (!quote) return null;
    const components = this.quoteComponents.get(id) ?? [];
    return {
      quote: { ...quote },
      components: components.map((c) => ({ ...c })),
    };
  }

  async upsertDriver(driver: DriverRow): Promise<DriverRow> {
    const existing = [...this.drivers.values()].find(
      (d) => d.phone === driver.phone,
    );
    if (existing) return { ...existing };
    this.drivers.set(driver.id, { ...driver });
    return { ...driver };
  }

  async getDriver(id: string): Promise<DriverRow | null> {
    const driver = this.drivers.get(id);
    return driver ? { ...driver } : null;
  }

  async getDriverByPhone(phone: string): Promise<DriverRow | null> {
    const driver = [...this.drivers.values()].find((d) => d.phone === phone);
    return driver ? { ...driver } : null;
  }

  async getRide(id: string): Promise<RideRow | null> {
    const ride = this.rides.get(id);
    return ride ? { ...ride } : null;
  }

  async updateRide(id: string, patch: Partial<RideRow>): Promise<RideRow> {
    const ride = this.rides.get(id);
    if (!ride) throw new Error(`ride ${id} not found`);
    const next = { ...ride, ...patch };
    this.rides.set(id, next);
    return { ...next };
  }

  async persistAuthorization(input: {
    quoteId: string;
    ride: RideRow;
    payment: PaymentRow;
    postings: LedgerPosting[];
  }): Promise<RideRow> {
    // Build everything first; only mutate once nothing can throw.
    const entries = this.toEntries(this.freshPostings(input.postings));
    const quote = this.quotes.get(input.quoteId);

    this.rides.set(input.ride.id, { ...input.ride });
    this.payments.set(input.payment.id, { ...input.payment });
    this.ledger.push(...entries);
    if (quote) quote.status = 'consumed';

    return { ...input.ride };
  }

  async persistCapture(input: {
    rideId: string;
    ridePatch: Partial<RideRow>;
    paymentPatch: Partial<PaymentRow>;
    postings: LedgerPosting[];
  }): Promise<void> {
    const ride = this.rides.get(input.rideId);
    if (!ride) throw new Error(`ride ${input.rideId} not found`);
    const payment = this.paymentByRide(input.rideId);
    const entries = this.toEntries(this.freshPostings(input.postings));

    this.rides.set(input.rideId, { ...ride, ...input.ridePatch });
    if (payment) {
      this.payments.set(payment.id, { ...payment, ...input.paymentPatch });
    }
    this.ledger.push(...entries);
  }

  async persistVoid(input: {
    rideId: string;
    ridePatch: Partial<RideRow>;
    paymentPatch: Partial<PaymentRow>;
    postings: LedgerPosting[];
  }): Promise<void> {
    const ride = this.rides.get(input.rideId);
    if (!ride) throw new Error(`ride ${input.rideId} not found`);
    const payment = this.paymentByRide(input.rideId);
    const entries = this.toEntries(this.freshPostings(input.postings));

    this.rides.set(input.rideId, { ...ride, ...input.ridePatch });
    if (payment) {
      this.payments.set(payment.id, { ...payment, ...input.paymentPatch });
    }
    this.ledger.push(...entries);
  }

  async getPaymentByRide(rideId: string): Promise<PaymentRow | null> {
    const payment = this.paymentByRide(rideId);
    return payment ? { ...payment } : null;
  }

  async ledgerForRide(rideId: string): Promise<LedgerEntryRow[]> {
    return this.ledger
      .filter((e) => e.rideId === rideId)
      .map((e) => ({ ...e }));
  }

  async ledgerForDriver(driverId: string): Promise<LedgerEntryRow[]> {
    return this.ledger
      .filter((e) => e.driverId === driverId)
      .map((e) => ({ ...e }));
  }

  async completedRidesForRider(
    riderPhone: string,
    region: string,
  ): Promise<RideRow[]> {
    return [...this.rides.values()]
      .filter(
        (r) =>
          r.riderPhone === riderPhone &&
          r.region === region &&
          r.status === 'completed',
      )
      .map((r) => ({ ...r }));
  }

  async completedRidesForDriver(
    driverId: string,
    region: string,
  ): Promise<RideRow[]> {
    return [...this.rides.values()]
      .filter(
        (r) =>
          r.driverId === driverId &&
          r.region === region &&
          r.status === 'completed',
      )
      .map((r) => ({ ...r }));
  }

  private paymentByRide(rideId: string): PaymentRow | undefined {
    return [...this.payments.values()].find((p) => p.rideId === rideId);
  }

  private freshPostings(postings: LedgerPosting[]): LedgerPosting[] {
    // Mirror the DB's UNIQUE(ride_id, kind, account) + ON CONFLICT DO NOTHING:
    // a replayed ledger group (retry, double-tap, webhook redelivery) is skipped
    // here exactly as Postgres would skip it, so take-home is never doubled.
    return postings.filter(
      (p) =>
        !this.ledger.some(
          (e) =>
            e.rideId === p.rideId &&
            e.kind === p.kind &&
            e.account === p.account,
        ),
    );
  }

  private toEntries(postings: LedgerPosting[]): LedgerEntryRow[] {
    // A monotonic counter stands in for insertion time so ordering is stable
    // without depending on the wall clock.
    return postings.map((p) => ({
      ...p,
      id: randomUUID(),
      createdAt: new Date(this.ledgerClock++),
    }));
  }
}
