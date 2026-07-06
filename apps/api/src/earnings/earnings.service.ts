import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { LedgerService } from '../ledger/ledger.service';
import { KINDS, type LedgerEntryRow } from '../ledger/ledger.types';
import { formatUsd } from '../money/money';
import {
  RIDE_REPOSITORY,
  type RideRepository,
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
