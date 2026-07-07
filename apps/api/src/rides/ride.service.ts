import { randomInt, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AUTH_REPOSITORY,
  type AuthRepository,
} from '../auth/auth.repository';
import { CLOCK, type Clock } from '../clock/clock';
import { ENV, type Env } from '../config/env';
import {
  EarningsService,
  type TripEarningsView,
} from '../earnings/earnings.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
} from '../payments/payment-gateway';
import {
  RIDE_REPOSITORY,
  type PaymentRow,
  type RideRepository,
  type RideRow,
} from '../persistence/repository';

export interface ConfirmRideInput {
  quoteId: string;
  riderPhone: string;
  /** Display-only echo from the client. Server IGNORES it and uses the locked quote total. */
  amountCents?: number;
}

export interface RideView {
  id: string;
  riderPhone: string;
  driverId: string | null;
  region: string;
  status: RideRow['status'];
  fareCents: number;
  currency: string;
  quoteId: string | null;
  paymentIntentId: string | null;
  pickupLabel: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  offerExpiresAt: string | null;
  authorizedAt: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  lastLat: number | null;
  lastLng: number | null;
  lastPingAt: string | null;
  createdAt: string;
}

/** Rider-facing OTP handoff — the code the rider reads aloud to the driver. */
export interface RiderOtpView {
  rideId: string;
  status: RideRow['status'];
  /** The pickup code, present only while the ride is accepted and the OTP is live. */
  otp: string | null;
  expiresAt: string | null;
}

export interface ReceiptView {
  rideId: string;
  riderPhone: string;
  status: RideRow['status'];
  currency: string;
  /** The locked quote total — what the rider agreed to. */
  fareCents: number;
  /** What was actually charged. Equals fareCents; there is no post-trip adjustment. */
  amountChargedCents: number;
  captured: boolean;
  quoteId: string | null;
  components: Array<{
    kind: string;
    label: string;
    amountCents: number;
    sortOrder: number;
  }>;
}

export interface ConfirmResult {
  ride: RideView;
  receipt: ReceiptView;
}

export interface CompleteResult {
  ride: RideView;
  earnings: TripEarningsView;
}

export interface RepeatStatus {
  subject: string;
  region: string;
  repeatedWithin7Days: boolean;
  ridesCount: number;
  firstRideAt: string | null;
  lastRideAt: string | null;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// How long a paid, offered ride stays claimable by a driver before its offer
// lapses.
const OFFER_TTL_MS = 5 * 60 * 1000;
// Short-lived, single-use pickup OTP minted at accept time.
const OTP_TTL_MS = 5 * 60 * 1000;
// Wrong-code attempts allowed before the OTP is locked out.
const MAX_OTP_ATTEMPTS = 5;

/** Generates a zero-padded 6-digit pickup code from a CSPRNG. */
function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

@Injectable()
export class RideService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly ledger: LedgerService,
    private readonly earnings: EarningsService,
    @Inject(AUTH_REPOSITORY) private readonly authRepo: AuthRepository,
  ) {}

  /**
   * Confirm & pay: authorize the EXACT locked quote total, create the ride, and
   * post the authorization hold — all atomically. A client-supplied amount is
   * never trusted.
   */
  async confirm(input: ConfirmRideInput): Promise<ConfirmResult> {
    if (!input.quoteId) throw new BadRequestException('quoteId is required');
    if (!input.riderPhone) {
      throw new BadRequestException('riderPhone is required');
    }

    const found = await this.repo.getQuote(input.quoteId);
    if (!found) throw new NotFoundException(`quote ${input.quoteId} not found`);
    const { quote, components } = found;

    if (quote.region !== this.env.activeRegion) {
      throw new BadRequestException(
        `quote region '${quote.region}' is not served`,
      );
    }
    if (quote.riderPhone !== input.riderPhone) {
      throw new BadRequestException('riderPhone does not match the quote');
    }

    const now = this.clock.now();
    if (quote.status !== 'active' || quote.expiresAt.getTime() <= now.getTime()) {
      // Reject BEFORE any authorization or ledger write happens.
      throw new ConflictException(
        'quote has expired or has already been used',
      );
    }

    // SERVER-AUTHORITATIVE: the charge is the persisted quote total, full stop.
    const amountCents = quote.totalCents;
    const rideId = randomUUID();
    const idempotencyKey = `auth:${rideId}`;

    // Authorize against the rider's saved card when they have one, so a repeat
    // ride needs no card re-entry (SCRUM-240 AC). The amount is still the locked
    // quote total — the saved card changes WHO is charged, never HOW MUCH.
    const savedCard =
      await this.authRepo.getDefaultPaymentMethodForPhone(quote.riderPhone);

    const authorization = await this.gateway.authorize({
      rideId,
      amountCents,
      currency: quote.currency,
      idempotencyKey,
      paymentMethodId: savedCard?.stripePaymentMethodId,
      customerId: savedCard?.stripeCustomerId ?? undefined,
    });

    const ride: RideRow = {
      id: rideId,
      riderPhone: quote.riderPhone,
      quoteId: quote.id,
      driverId: null,
      region: quote.region,
      // The rider has paid/locked the fare; the ride is now OFFERED to drivers.
      // (The payment row separately tracks its own 'authorized' status.)
      status: 'offered',
      fareCents: amountCents,
      currency: quote.currency,
      paymentIntentId: authorization.intentId,
      pickupLabel: quote.pickupLabel,
      pickupLat: quote.pickupLat,
      pickupLng: quote.pickupLng,
      offerExpiresAt: new Date(now.getTime() + OFFER_TTL_MS),
      otpCode: null,
      otpExpiresAt: null,
      otpAttempts: 0,
      otpConsumedAt: null,
      authorizedAt: now,
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      lastLat: null,
      lastLng: null,
      lastPingAt: null,
      createdAt: now,
    };
    const payment: PaymentRow = {
      id: randomUUID(),
      rideId,
      gateway: authorization.gateway,
      intentId: authorization.intentId,
      idempotencyKey,
      amountCents,
      currency: quote.currency,
      status: 'authorized',
      createdAt: now,
      updatedAt: now,
    };
    const postings = this.ledger.buildAuthorizationPostings({
      rideId,
      amountCents,
      entryGroupId: randomUUID(),
    });

    const persisted = await this.repo.persistAuthorization({
      quoteId: quote.id,
      ride,
      payment,
      postings,
    });

    return {
      ride: toRideView(persisted),
      receipt: {
        rideId,
        riderPhone: quote.riderPhone,
        status: persisted.status,
        currency: quote.currency,
        fareCents: amountCents,
        amountChargedCents: amountCents,
        captured: false,
        quoteId: quote.id,
        components: [...components]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((c) => ({
            kind: c.kind,
            label: c.label,
            amountCents: c.amountCents,
            sortOrder: c.sortOrder,
          })),
      },
    };
  }

  /**
   * Driver accepts an OFFERED ride. The assignment + OTP mint happen in ONE
   * atomic compare-and-set (acceptOffer), so if N drivers race, exactly one wins
   * and the rest get 409 — the ride row can only ever hold one driver_id. No
   * money moves here. The minted OTP is never returned to the driver; the rider
   * reads it from their own app.
   */
  async accept(rideId: string, driverId: string): Promise<RideView> {
    // Pre-checks decide the error code (404 unknown ride, 400 bad driver) but
    // are NOT what makes accept race-safe — the atomic CAS below is.
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    const driver = await this.repo.getDriver(driverId);
    if (!driver) throw new BadRequestException(`driver ${driverId} not found`);
    if (!driver.active) {
      throw new BadRequestException(`driver ${driverId} is not active`);
    }
    if (driver.region !== ride.region) {
      throw new BadRequestException('driver is not in the ride region');
    }

    const now = this.clock.now();
    const claimed = await this.repo.acceptOffer({
      rideId,
      driverId,
      now,
      otpCode: generateOtp(),
      otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
    });
    if (claimed) return toRideView(claimed);

    // Lost the race (or the offer was never claimable). Re-read to explain why.
    const current = await this.repo.getRide(rideId);
    if (!current) throw new NotFoundException(`ride ${rideId} not found`);
    if (
      current.status === 'offered' &&
      current.offerExpiresAt !== null &&
      current.offerExpiresAt.getTime() <= now.getTime()
    ) {
      throw new GoneException(`ride ${rideId} offer has expired`);
    }
    throw new ConflictException(
      `ride ${rideId} cannot be accepted from status '${current.status}'`,
    );
  }

  /**
   * The pickup OTP for the rider to read aloud. Rider-facing: the code is only
   * revealed while the ride is accepted and the OTP is still live and unconsumed.
   */
  async getOtpForRider(rideId: string): Promise<RiderOtpView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    const now = this.clock.now();
    const live =
      ride.status === 'accepted' &&
      ride.otpCode !== null &&
      ride.otpConsumedAt === null &&
      (ride.otpExpiresAt === null || ride.otpExpiresAt.getTime() > now.getTime());
    return {
      rideId,
      status: ride.status,
      otp: live ? ride.otpCode : null,
      expiresAt: live ? ride.otpExpiresAt?.toISOString() ?? null : null,
    };
  }

  /**
   * OTP trip start: the driver enters the code the rider read aloud. On a correct
   * code the ride transitions accepted -> in_progress and the OTP is consumed
   * (single-use). A wrong code increments the attempt counter and is rejected;
   * after MAX_OTP_ATTEMPTS the OTP is locked out. Expired or already-consumed
   * codes are rejected too. Only now does the server begin accepting GPS pings.
   */
  async startTrip(rideId: string, otp: string): Promise<RideView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    if (ride.status === 'in_progress') {
      throw new ConflictException(`ride ${rideId} trip already started`);
    }
    if (ride.status !== 'accepted') {
      throw new ConflictException(
        `ride ${rideId} cannot start a trip from status '${ride.status}'`,
      );
    }
    if (ride.otpConsumedAt !== null || ride.otpCode === null) {
      throw new BadRequestException('OTP has already been used');
    }
    if (ride.otpAttempts >= MAX_OTP_ATTEMPTS) {
      throw new BadRequestException('too many incorrect OTP attempts — locked out');
    }
    const now = this.clock.now();
    if (ride.otpExpiresAt !== null && ride.otpExpiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException('OTP has expired');
    }
    if (!otp || otp !== ride.otpCode) {
      // Persist the failed attempt so lockout survives across requests.
      await this.repo.updateRide(rideId, {
        otpAttempts: ride.otpAttempts + 1,
      });
      throw new BadRequestException('incorrect OTP');
    }

    const updated = await this.repo.updateRide(rideId, {
      status: 'in_progress',
      startedAt: now,
      otpConsumedAt: now,
      // Consumed: clear the plaintext so it can never be shown or reused.
      otpCode: null,
    });
    return toRideView(updated);
  }

  /**
   * Complete the trip: capture the locked total and, only if the gateway
   * succeeds, atomically advance the ride and post the capture ledger. If the
   * gateway throws, nothing is written — no captured payment, no ledger entry.
   */
  async complete(rideId: string): Promise<CompleteResult> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    if (!ride.driverId) {
      throw new ConflictException('ride has no assigned driver');
    }
    // Completable from 'accepted' (fare captured without an OTP trip-start, e.g.
    // the SCRUM-243 flow) or from 'in_progress' (after OTP trip-start).
    if (ride.status !== 'accepted' && ride.status !== 'in_progress') {
      throw new ConflictException(
        `ride ${rideId} cannot be completed from status '${ride.status}'`,
      );
    }
    const payment = await this.repo.getPaymentByRide(rideId);
    if (!payment || payment.status !== 'authorized' || !ride.paymentIntentId) {
      throw new ConflictException('ride has no authorized payment to capture');
    }

    // Gateway FIRST. If it throws, we never reach the persist call below.
    await this.gateway.capture({
      intentId: ride.paymentIntentId,
      amountCents: ride.fareCents,
      idempotencyKey: `capture:${rideId}`,
    });

    const now = this.clock.now();
    const postings = this.ledger.buildCapturePostings({
      rideId,
      driverId: ride.driverId,
      amountCents: ride.fareCents,
      entryGroupId: randomUUID(),
    });
    await this.repo.persistCapture({
      rideId,
      ridePatch: { status: 'completed', completedAt: now },
      paymentPatch: { status: 'captured', updatedAt: now },
      postings,
    });

    const updated = await this.repo.getRide(rideId);
    return {
      ride: toRideView(updated as RideRow),
      earnings: await this.earnings.tripEarnings(rideId),
    };
  }

  /** Cancel before completion: void the authorization and post reversing entries. */
  async cancel(rideId: string): Promise<RideView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    if (ride.status === 'completed') {
      throw new ConflictException('cannot cancel a completed ride');
    }
    if (ride.status === 'cancelled') {
      return toRideView(ride);
    }
    const payment = await this.repo.getPaymentByRide(rideId);

    if (ride.paymentIntentId) {
      await this.gateway.voidAuthorization({
        intentId: ride.paymentIntentId,
        idempotencyKey: `void:${rideId}`,
      });
    }

    const now = this.clock.now();
    const postings = this.ledger.buildVoidPostings({
      rideId,
      amountCents: ride.fareCents,
      entryGroupId: randomUUID(),
    });
    await this.repo.persistVoid({
      rideId,
      ridePatch: { status: 'cancelled', cancelledAt: now },
      paymentPatch: payment ? { status: 'voided', updatedAt: now } : {},
      postings,
    });

    const updated = await this.repo.getRide(rideId);
    return toRideView(updated as RideRow);
  }

  async getRideView(rideId: string): Promise<RideView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    return toRideView(ride);
  }

  async receipt(rideId: string): Promise<ReceiptView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    const payment = await this.repo.getPaymentByRide(rideId);

    let components: ReceiptView['components'] = [];
    if (ride.quoteId) {
      const found = await this.repo.getQuote(ride.quoteId);
      if (found) {
        components = [...found.components]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((c) => ({
            kind: c.kind,
            label: c.label,
            amountCents: c.amountCents,
            sortOrder: c.sortOrder,
          }));
      }
    }

    return {
      rideId,
      riderPhone: ride.riderPhone,
      status: ride.status,
      currency: ride.currency,
      fareCents: ride.fareCents,
      amountChargedCents: ride.fareCents,
      captured: payment?.status === 'captured',
      quoteId: ride.quoteId,
      components,
    };
  }

  async riderRepeatStatus(
    riderPhone: string,
    region: string,
  ): Promise<RepeatStatus> {
    const rides = await this.repo.completedRidesForRider(riderPhone, region);
    return this.repeatStatus(riderPhone, region, rides);
  }

  async driverRepeatStatus(
    driverId: string,
    region: string,
  ): Promise<RepeatStatus> {
    const rides = await this.repo.completedRidesForDriver(driverId, region);
    return this.repeatStatus(driverId, region, rides);
  }

  private repeatStatus(
    subject: string,
    region: string,
    rides: RideRow[],
  ): RepeatStatus {
    const completed = rides
      .filter((r): r is RideRow & { completedAt: Date } => r.completedAt !== null)
      .sort((a, b) => a.completedAt.getTime() - b.completedAt.getTime());

    let repeatedWithin7Days = false;
    for (let i = 1; i < completed.length; i++) {
      const gap =
        completed[i].completedAt.getTime() -
        completed[i - 1].completedAt.getTime();
      if (gap <= WEEK_MS) {
        repeatedWithin7Days = true;
        break;
      }
    }

    return {
      subject,
      region,
      repeatedWithin7Days,
      ridesCount: completed.length,
      firstRideAt: completed[0]?.completedAt.toISOString() ?? null,
      lastRideAt:
        completed[completed.length - 1]?.completedAt.toISOString() ?? null,
    };
  }
}

export function toRideView(ride: RideRow): RideView {
  return {
    id: ride.id,
    riderPhone: ride.riderPhone,
    driverId: ride.driverId,
    region: ride.region,
    status: ride.status,
    fareCents: ride.fareCents,
    currency: ride.currency,
    quoteId: ride.quoteId,
    paymentIntentId: ride.paymentIntentId,
    pickupLabel: ride.pickupLabel,
    pickupLat: ride.pickupLat,
    pickupLng: ride.pickupLng,
    offerExpiresAt: ride.offerExpiresAt?.toISOString() ?? null,
    authorizedAt: ride.authorizedAt?.toISOString() ?? null,
    acceptedAt: ride.acceptedAt?.toISOString() ?? null,
    startedAt: ride.startedAt?.toISOString() ?? null,
    completedAt: ride.completedAt?.toISOString() ?? null,
    cancelledAt: ride.cancelledAt?.toISOString() ?? null,
    lastLat: ride.lastLat,
    lastLng: ride.lastLng,
    lastPingAt: ride.lastPingAt?.toISOString() ?? null,
    createdAt: ride.createdAt.toISOString(),
  };
}