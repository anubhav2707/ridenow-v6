import type { Cents } from '../money/money';
import type { LedgerEntryRow, LedgerPosting } from '../ledger/ledger.types';

// Persisted row shapes. These mirror the Drizzle schema but are plain interfaces
// so the domain never imports the ORM. The in-memory implementation (tests +
// local default) and the Drizzle implementation (postgres) both satisfy the
// RideRepository port below.

export type QuoteStatus = 'active' | 'consumed' | 'expired';

export interface QuoteRow {
  id: string;
  riderPhone: string;
  region: string;
  pickupLabel: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLabel: string;
  dropoffLat: number;
  dropoffLng: number;
  distanceMeters: number;
  durationSeconds: number;
  currency: string;
  totalCents: Cents;
  status: QuoteStatus;
  expiresAt: Date;
  createdAt: Date;
}

export interface QuoteComponentRow {
  id: string;
  quoteId: string;
  kind: string;
  label: string;
  amountCents: Cents;
  sortOrder: number;
}

export interface DriverRow {
  id: string;
  phone: string;
  displayName: string;
  region: string;
  subscriptionStatus: string;
  createdAt: Date;
}

export type RideStatus =
  | 'quoted'
  | 'authorized'
  | 'accepted'
  | 'completed'
  | 'cancelled';

export interface RideRow {
  id: string;
  riderPhone: string;
  quoteId: string | null;
  driverId: string | null;
  region: string;
  status: RideStatus;
  fareCents: Cents;
  currency: string;
  paymentIntentId: string | null;
  authorizedAt: Date | null;
  acceptedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export type PaymentStatus = 'authorized' | 'captured' | 'voided';

export interface PaymentRow {
  id: string;
  rideId: string;
  gateway: string;
  intentId: string;
  idempotencyKey: string;
  amountCents: Cents;
  currency: string;
  status: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The single persistence port for the money-critical flow. The three persist*
 * methods each write ride + payment + ledger in ONE transaction so ride state
 * and the ledger can never diverge.
 */
export interface RideRepository {
  // --- quotes ---
  insertQuote(quote: QuoteRow, components: QuoteComponentRow[]): Promise<void>;
  getQuote(
    id: string,
  ): Promise<{ quote: QuoteRow; components: QuoteComponentRow[] } | null>;

  // --- drivers ---
  upsertDriver(driver: DriverRow): Promise<DriverRow>;
  getDriver(id: string): Promise<DriverRow | null>;
  getDriverByPhone(phone: string): Promise<DriverRow | null>;

  // --- rides ---
  getRide(id: string): Promise<RideRow | null>;
  /** Non-money update (e.g. driver accepts). */
  updateRide(id: string, patch: Partial<RideRow>): Promise<RideRow>;

  // --- atomic money operations ---
  /** Insert ride + payment + authorization postings and consume the quote, atomically. */
  persistAuthorization(input: {
    quoteId: string;
    ride: RideRow;
    payment: PaymentRow;
    postings: LedgerPosting[];
  }): Promise<RideRow>;
  /** Advance ride to completed, mark payment captured, append capture postings, atomically. */
  persistCapture(input: {
    rideId: string;
    ridePatch: Partial<RideRow>;
    paymentPatch: Partial<PaymentRow>;
    postings: LedgerPosting[];
  }): Promise<void>;
  /** Advance ride to cancelled, mark payment voided, append reversing postings, atomically. */
  persistVoid(input: {
    rideId: string;
    ridePatch: Partial<RideRow>;
    paymentPatch: Partial<PaymentRow>;
    postings: LedgerPosting[];
  }): Promise<void>;

  // --- reads for ledger / receipts / repeat metrics ---
  getPaymentByRide(rideId: string): Promise<PaymentRow | null>;
  ledgerForRide(rideId: string): Promise<LedgerEntryRow[]>;
  ledgerForDriver(driverId: string): Promise<LedgerEntryRow[]>;
  completedRidesForRider(
    riderPhone: string,
    region: string,
  ): Promise<RideRow[]>;
  completedRidesForDriver(
    driverId: string,
    region: string,
  ): Promise<RideRow[]>;
}

/** Nest DI token for the active RideRepository. */
export const RIDE_REPOSITORY = Symbol('RIDE_REPOSITORY');
