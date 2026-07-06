import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getPlan } from '../common/plan-catalog';
import { ENV, type Env } from '../config/env';
import { LedgerService } from '../ledger/ledger.service';
import { KINDS, type LedgerEntryRow } from '../ledger/ledger.types';
import { formatUsd } from '../money/money';
import {
  RIDE_REPOSITORY,
  type RideRepository,
  type RideStatus,
} from '../persistence/repository';

export interface TripEarningsLine {
  label: string;
  amountCents: number;
  kind: string;
}

export interface TripEarningsView {
  rideId: string;
  driverId: string | null;
  currency: string;
  fareCents: number;
  /** Derived from the ledger — the full rider-paid fare. */
  takeHomeCents: number;
  takeHomeDisplay: string;
  /** Explicit $0 line: the flat-fee/subscription model made visible. */
  platformCommissionCents: number;
  /** True when Σdebits === Σcredits across this ride's postings. */
  balanced: boolean;
  lines: TripEarningsLine[];
  postings: LedgerEntryRow[];
}

export interface TakeHomeLedgerLine {
  label: string;
  amountCents: number;
  kind: string;
}

/**
 * The SCRUM-241 driver take-home ledger screen for a single trip. It shows the
 * locked upfront fare, the flat subscription fee as the ONLY (per-trip $0)
 * deduction line, and a "You Keep" total equal to 100% of the fare. There is NO
 * percentage-commission line anywhere in this view.
 */
export interface TakeHomeLedgerView {
  rideId: string;
  driverId: string | null;
  currency: string;
  status: RideStatus;
  /** True once the rider's payment has been captured. */
  paid: boolean;
  /** (1) The locked upfront fare the rider paid, in integer minor units. */
  upfrontFareCents: number;
  upfrontFareDisplay: string;
  plan: string | null;
  /** The flat monthly subscription fee — context/header, billed monthly, not per trip. */
  subscriptionFeeCents: number;
  subscriptionFeeDisplay: string;
  /** The only per-trip deduction: $0. */
  perTripDeductionCents: number;
  /** (2) Itemized lines: upfront fare + the flat subscription-fee line. */
  lines: TakeHomeLedgerLine[];
  /** (3) You Keep = 100% of the upfront fare, derived from the immutable ledger. */
  youKeepCents: number;
  youKeepDisplay: string;
}

export interface DriverEarningsSummary {
  driverId: string;
  currency: string;
  trips: number;
  cumulativeTakeHomeCents: number;
  cumulativeTakeHomeDisplay: string;
  platformCommissionCents: number;
  uberReferenceCommissionBps: number;
  /** Display-only: what a legacy % platform would have skimmed from these fares. */
  uberWouldHaveTakenCents: number;
  /** Display-only: how much more the driver kept by keeping 100%. */
  youKeptExtraCents: number;
  youKeptExtraDisplay: string;
  message: string;
}

/**
 * Reads driver take-home straight off the append-only ledger. Nothing here
 * stores or mutates an earnings number — it is always derived, so it cannot
 * drift from the money that actually moved.
 */
@Injectable()
export class EarningsService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(ENV) private readonly env: Env,
    private readonly ledger: LedgerService,
  ) {}

  async tripEarnings(rideId: string): Promise<TripEarningsView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    const postings = await this.repo.ledgerForRide(rideId);

    const takeHomeCents = ride.driverId
      ? LedgerService.driverTakeHomeCents(postings, ride.driverId)
      : 0;
    const commissionCents = postings
      .filter((p) => p.kind === KINDS.platformCommission)
      .reduce((acc, p) => acc + p.amountCents, 0);

    const lines: TripEarningsLine[] = [
      {
        label: 'Rider paid (fare)',
        amountCents: ride.fareCents,
        kind: 'fare',
      },
      {
        label: 'Platform commission',
        amountCents: commissionCents,
        kind: KINDS.platformCommission,
      },
      {
        label: 'Your take-home',
        amountCents: takeHomeCents,
        kind: KINDS.driverEarnings,
      },
    ];

    return {
      rideId,
      driverId: ride.driverId,
      currency: ride.currency,
      fareCents: ride.fareCents,
      takeHomeCents,
      takeHomeDisplay: formatUsd(takeHomeCents),
      platformCommissionCents: commissionCents,
      balanced: this.ledger.isBalanced(postings),
      lines,
      postings,
    };
  }

  /**
   * The per-trip take-home ledger (SCRUM-241). Take-home ("You Keep") is DERIVED
   * from the append-only double-entry ledger — the same immutable locked-fare
   * snapshot the rider paid — so it is cent-exact and cannot drift. The flat
   * subscription fee is surfaced as a monthly context line with a $0 per-trip
   * deduction, so You Keep === 100% of the fare and no commission line appears.
   */
  async tripTakeHomeLedger(rideId: string): Promise<TakeHomeLedgerView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    const payment = await this.repo.getPaymentByRide(rideId);
    const postings = await this.repo.ledgerForRide(rideId);

    // Prefer the ledger-derived take-home (the money that actually moved). Before
    // capture there are no earnings postings yet, so fall back to the locked fare.
    const derivedTakeHome = ride.driverId
      ? LedgerService.driverTakeHomeCents(postings, ride.driverId)
      : 0;
    const paid = payment?.status === 'captured';
    const youKeepCents = paid ? derivedTakeHome : ride.fareCents;
    const upfrontFareCents = ride.fareCents;

    // Subscription fee comes from the driver's chosen plan (flat, monthly).
    let plan: string | null = null;
    let subscriptionFeeCents = 0;
    if (ride.driverId) {
      const driver = await this.repo.getDriver(ride.driverId);
      if (driver) {
        plan = driver.plan;
        subscriptionFeeCents =
          driver.subscriptionFeeCents ||
          (driver.plan ? getPlan(driver.plan)?.subscriptionFeeCents ?? 0 : 0);
      }
    }

    const planLabel = plan ? getPlan(plan)?.label ?? plan : 'subscription';
    const lines: TakeHomeLedgerLine[] = [
      {
        label: 'Upfront fare (rider paid)',
        amountCents: upfrontFareCents,
        kind: 'fare',
      },
      {
        // The ONLY deduction line. The flat fee is billed monthly, so the
        // per-trip deduction is $0 — which is exactly why You Keep is 100%.
        label: `Subscription fee (${planLabel}) — billed monthly, $0 per trip`,
        amountCents: 0,
        kind: 'subscription_fee',
      },
    ];

    return {
      rideId,
      driverId: ride.driverId,
      currency: ride.currency,
      status: ride.status,
      paid,
      upfrontFareCents,
      upfrontFareDisplay: formatUsd(upfrontFareCents),
      plan,
      subscriptionFeeCents,
      subscriptionFeeDisplay: formatUsd(subscriptionFeeCents),
      perTripDeductionCents: 0,
      lines,
      youKeepCents,
      youKeepDisplay: formatUsd(youKeepCents),
    };
  }

  async driverSummary(driverId: string): Promise<DriverEarningsSummary> {
    const driver = await this.repo.getDriver(driverId);
    if (!driver) throw new NotFoundException(`driver ${driverId} not found`);
    const postings = await this.repo.ledgerForDriver(driverId);

    const cumulativeTakeHomeCents = LedgerService.driverTakeHomeCents(
      postings,
      driverId,
    );
    const trips = new Set(
      postings
        .filter((p) => p.kind === KINDS.driverEarnings && p.rideId)
        .map((p) => p.rideId),
    ).size;

    const uberWouldHaveTakenCents = Math.round(
      (cumulativeTakeHomeCents * this.env.uberReferenceCommissionBps) / 10_000,
    );
    // The driver kept 100%, so everything the legacy cut would have taken is
    // extra money in their pocket.
    const youKeptExtraCents = uberWouldHaveTakenCents;
    const pct = (this.env.uberReferenceCommissionBps / 100).toFixed(0);

    return {
      driverId,
      currency: this.env.currency,
      trips,
      cumulativeTakeHomeCents,
      cumulativeTakeHomeDisplay: formatUsd(cumulativeTakeHomeCents),
      platformCommissionCents: 0,
      uberReferenceCommissionBps: this.env.uberReferenceCommissionBps,
      uberWouldHaveTakenCents,
      youKeptExtraCents,
      youKeptExtraDisplay: formatUsd(youKeptExtraCents),
      message:
        `You kept 100% of ${formatUsd(cumulativeTakeHomeCents)} across ` +
        `${trips} trip${trips === 1 ? '' : 's'} — ` +
        `${formatUsd(youKeptExtraCents)} more than a ${pct}% platform cut.`,
    };
  }
}
