import { randomInt } from 'node:crypto';
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
  RIDE_REPOSITORY,
  type DriverRow,
  type RideRepository,
  type RideRow,
} from '../persistence/repository';
import { haversineMeters } from '../routing/routing';
import {
  assertTransition,
  IllegalTransitionError,
  type AssignmentView,
  type DriverCandidate,
  type OpenRequestView,
  type TripStatus,
} from './dispatch.types';

// How long the minted pickup OTP stays valid — mirrors RideService.accept, so an
// operator-assigned ride starts exactly like a self-accepted one.
const OTP_TTL_MS = 5 * 60 * 1000;

/** Zero-padded 6-digit pickup code from a CSPRNG (same shape as RideService). */
function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Semi-automated "concierge" dispatch. Deliberately dumb matching: the operator
 * console lists open requests and ranks nearby available drivers for a one-click
 * assign, and the greedy nearest-available loop offers candidates in order until
 * one is atomically claimed — escalating to the human dispatcher only when no
 * available driver can be claimed. No surge, no ML routing, no queues.
 *
 * Assignment reuses the ride state machine: a claim moves the ride offered ->
 * accepted for exactly one driver (never double-assigning a driver) and mints the
 * pickup OTP, so the trip can start immediately. Fixed versioned pricing means the
 * assignment never reprices the locked fare.
 */
@Injectable()
export class DispatchService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Record a driver's last-known position for proximity ranking. */
  async updateDriverLocation(
    driverId: string,
    lat: number,
    lng: number,
  ): Promise<{ driverId: string; lat: number; lng: number; at: string }> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('lat and lng must be finite numbers');
    }
    const driver = await this.repo.getDriver(driverId);
    if (!driver) throw new NotFoundException(`driver ${driverId} not found`);
    const at = this.clock.now();
    const saved = await this.repo.updateDriverLocation({
      driverId,
      lat,
      lng,
      at,
    });
    return {
      driverId: saved.id,
      lat: saved.lastLat as number,
      lng: saved.lastLng as number,
      at: at.toISOString(),
    };
  }

  /** The operator queue: offered, driverless requests in the active region. */
  async listOpenRequests(region?: string): Promise<OpenRequestView[]> {
    const rides = await this.repo.openRideRequests(
      region ?? this.env.activeRegion,
    );
    return rides.map(toOpenRequestView);
  }

  /**
   * Rank the available drivers for a request by straight-line distance to the
   * pickup (nearest first). Candidates already exclude drivers on an active ride.
   */
  async rankCandidates(rideId: string): Promise<DriverCandidate[]> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    if (ride.pickupLat === null || ride.pickupLng === null) {
      throw new ConflictException(`ride ${rideId} has no pickup location`);
    }
    const drivers = await this.repo.availableDriversForRegion(ride.region);
    return this.rankDrivers(ride, drivers);
  }

  /**
   * Assign a driver to an offered request. With `driverId` the operator picks a
   * specific driver; without it the greedy nearest-available loop offers ranked
   * candidates until one is atomically claimed. Escalates (409) when no available
   * driver can be claimed. Never double-assigns a driver and never reprices.
   */
  async assign(rideId: string, driverId?: string): Promise<AssignmentView> {
    const ride = await this.repo.getRide(rideId);
    if (!ride) throw new NotFoundException(`ride ${rideId} not found`);
    // Guard the state machine BEFORE touching drivers: only an 'offered' ride can
    // be assigned (offered -> accepted). An illegal source status is rejected.
    this.guardTransition(ride.status, 'accepted');

    if (driverId) {
      const claimed = await this.tryClaim(ride, driverId);
      if (claimed) return this.toAssignmentView(claimed, false);
      // Explain the failure with the right error code.
      await this.explainFailedClaim(ride.id, driverId);
    }

    // Greedy nearest-available: offer ranked candidates in order until one is
    // claimed. A candidate taken by a racing request just falls through to the
    // next — the losing request is offered the next candidate, not failed.
    const candidates = await this.rankCandidates(rideId);
    for (const candidate of candidates) {
      const claimed = await this.tryClaim(ride, candidate.driverId);
      if (claimed) return this.toAssignmentView(claimed, true);
    }
    throw new ConflictException(
      `no available driver could be assigned to ride ${rideId} — escalate to the human dispatcher`,
    );
  }

  /** Enforce the trip state machine, surfacing an illegal move as a 409. */
  private guardTransition(from: TripStatus, to: TripStatus): void {
    try {
      assertTransition(from, to);
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /** Atomic claim of one driver for one offered ride (never double-assigns). */
  private async tryClaim(
    ride: RideRow,
    driverId: string,
  ): Promise<RideRow | null> {
    const now = this.clock.now();
    return this.repo.assignDriver({
      rideId: ride.id,
      driverId,
      now,
      otpCode: generateOtp(),
      otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
    });
  }

  private rankDrivers(ride: RideRow, drivers: DriverRow[]): DriverCandidate[] {
    const pickup = { lat: ride.pickupLat as number, lng: ride.pickupLng as number };
    return drivers
      .filter((d) => d.lastLat !== null && d.lastLng !== null)
      .map((d) => ({
        driverId: d.id,
        displayName: d.displayName,
        region: d.region,
        distanceMeters: Math.round(
          haversineMeters(pickup, {
            lat: d.lastLat as number,
            lng: d.lastLng as number,
          }),
        ),
        lastLocationAt: d.lastLocationAt?.toISOString() ?? null,
      }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
  }

  /** After a failed explicit claim, surface why (bad driver vs lost the race). */
  private async explainFailedClaim(
    rideId: string,
    driverId: string,
  ): Promise<never> {
    const driver = await this.repo.getDriver(driverId);
    if (!driver) throw new BadRequestException(`driver ${driverId} not found`);
    if (!driver.active) {
      throw new BadRequestException(`driver ${driverId} is not active`);
    }
    const ride = await this.repo.getRide(rideId);
    if (ride && driver.region !== ride.region) {
      throw new BadRequestException('driver is not in the ride region');
    }
    throw new ConflictException(
      `driver ${driverId} could not be assigned to ride ${rideId} ` +
        `(already assigned, on another active ride, or the request is no longer open)`,
    );
  }

  private async toAssignmentView(
    ride: RideRow,
    autoAssigned: boolean,
  ): Promise<AssignmentView> {
    const driver = ride.driverId
      ? await this.repo.getDriver(ride.driverId)
      : null;
    // Dropoff lives on the locked quote; the ride only snapshots the pickup.
    let dropoff = { label: null as string | null, lat: null as number | null, lng: null as number | null };
    if (ride.quoteId) {
      const found = await this.repo.getQuote(ride.quoteId);
      if (found) {
        dropoff = {
          label: found.quote.dropoffLabel,
          lat: found.quote.dropoffLat,
          lng: found.quote.dropoffLng,
        };
      }
    }
    return {
      rideId: ride.id,
      driverId: ride.driverId as string,
      driverName: driver?.displayName ?? '',
      status: ride.status,
      autoAssigned,
      pickup: { label: ride.pickupLabel, lat: ride.pickupLat, lng: ride.pickupLng },
      dropoff,
      fareCents: ride.fareCents,
      currency: ride.currency,
      assignedAt: ride.acceptedAt?.toISOString() ?? this.clock.now().toISOString(),
      offerExpiresAt: ride.offerExpiresAt?.toISOString() ?? null,
      otpExpiresAt: ride.otpExpiresAt?.toISOString() ?? null,
    };
  }
}

function toOpenRequestView(ride: RideRow): OpenRequestView {
  return {
    rideId: ride.id,
    riderPhone: ride.riderPhone,
    region: ride.region,
    status: ride.status,
    fareCents: ride.fareCents,
    currency: ride.currency,
    pickupLabel: ride.pickupLabel,
    pickupLat: ride.pickupLat,
    pickupLng: ride.pickupLng,
    offerExpiresAt: ride.offerExpiresAt?.toISOString() ?? null,
    createdAt: ride.createdAt.toISOString(),
  };
}
