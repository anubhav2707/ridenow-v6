import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  authorizedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
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

@Injectable()
export class RideService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly ledger: LedgerService,
    private readonly earnings: EarningsService,
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

    const authorization = await this.gateway.authorize({
      rideId,
      amountCents,
      currency: quote.currency,
      idempotencyKey,
    });

    const ride: RideRow = {
      id: rideId,
      riderPhone: quote.riderPhone,
      quoteId: quote.id,
      driverId: null,
      region: quote.region,
      status: 'authorized',
      fareCents: amountCents,
      currency: quote.currency,
      paymentIntentId: authorization.intentId,
      authorizedAt: now,
      acceptedAt: null,
      completedAt: null,
      cancelledAt: null,
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

  /** Driver accepts an authorized ride. No money moves. */
  async accept(rideId: string, driverId: string): Promise<RideView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    const driver = await this.repo.getDriver(driverId);
    if (!driver) throw new BadRequestException(`driver ${driverId} not found`);
    if (driver.region !== ride.region) {
      throw new BadRequestException('driver is not in the ride region');
    }
    if (ride.status !== 'authorized') {
      throw new ConflictException(
        `ride ${rideId} cannot be accepted from status '${ride.status}'`,
      );
    }
    const updated = await this.repo.updateRide(rideId, {
      driverId,
      status: 'accepted',
      acceptedAt: this.clock.now(),
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
    if (ride.status !== 'accepted') {
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
    authorizedAt: ride.authorizedAt?.toISOString() ?? null,
    acceptedAt: ride.acceptedAt?.toISOString() ?? null,
    completedAt: ride.completedAt?.toISOString() ?? null,
    cancelledAt: ride.cancelledAt?.toISOString() ?? null,
    createdAt: ride.createdAt.toISOString(),
  };
}
