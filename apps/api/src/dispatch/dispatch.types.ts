import type { RideStatus } from '../persistence/repository';

// SINGLE source of truth for the dispatch feature's shared shapes and the trip
// state-machine transition table. Reuses the persisted RideStatus union rather
// than redeclaring statuses, so the machine can never drift from the store.
export type TripStatus = RideStatus;

/**
 * The only legal forward transitions of a trip, plus cancellation from any live
 * state. This is the authoritative table the dispatch flow validates against:
 *
 *   quoted -> offered -> accepted -> in_progress -> completed
 *
 * and any non-terminal state -> cancelled. `completed` (paid) and `cancelled`
 * are terminal. Completion is permitted from `accepted` as well as
 * `in_progress`, matching the fare-capture path that does not require an OTP
 * trip-start.
 */
export const TRIP_TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  quoted: ['offered', 'cancelled'],
  offered: ['accepted', 'cancelled'],
  accepted: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** Thrown when an illegal trip-status transition is attempted. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TripStatus,
    readonly to: TripStatus,
  ) {
    super(`illegal trip transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/** Guard: throws unless `from -> to` is a permitted transition. */
export function assertTransition(from: TripStatus, to: TripStatus): void {
  if (!TRIP_TRANSITIONS[from]?.includes(to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/** A nearby available driver ranked for one-click operator assignment. */
export interface DriverCandidate {
  driverId: string;
  displayName: string;
  region: string;
  /** Straight-line distance from the driver's last position to the pickup. */
  distanceMeters: number;
  lastLocationAt: string | null;
}

/** An open (offered, driverless) ride request in the operator queue. */
export interface OpenRequestView {
  rideId: string;
  riderPhone: string;
  region: string;
  status: TripStatus;
  fareCents: number;
  currency: string;
  pickupLabel: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  offerExpiresAt: string | null;
  createdAt: string;
}

/** The assignment details a driver is notified with (pickup, dropoff, locked fare). */
export interface AssignmentView {
  rideId: string;
  driverId: string;
  driverName: string;
  status: TripStatus;
  /** True when the driver was chosen by the greedy nearest-available loop. */
  autoAssigned: boolean;
  pickup: { label: string | null; lat: number | null; lng: number | null };
  dropoff: { label: string | null; lat: number | null; lng: number | null };
  /** The locked upfront fare — unchanged from the quote; assignment never reprices. */
  fareCents: number;
  currency: string;
  assignedAt: string;
  offerExpiresAt: string | null;
  otpExpiresAt: string | null;
}

/**
 * Bilateral repeat-liquidity report over a cohort of completed (paid) rides in a
 * single geography. `bilateralRepeatLiquidity` is the MVP kill metric: it is true
 * only when at least one RIDER and at least one DRIVER each completed a second
 * paid ride within the window, in the same geography.
 */
export interface RepeatLiquidityReport {
  region: string;
  windowDays: number;
  bilateralRepeatLiquidity: boolean;
  ridersWithRepeat: string[];
  driversWithRepeat: string[];
  riderRepeatCount: number;
  driverRepeatCount: number;
  totalCompletedRides: number;
  asOf: string;
}
