import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import { ENV, type Env } from '../config/env';
import {
  RIDE_REPOSITORY,
  type RideRepository,
  type RideRow,
} from '../persistence/repository';
import type { RepeatLiquidityReport } from './dispatch.types';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Instruments the MVP kill metric: BILATERAL repeat liquidity in one geography.
 * Over the cohort of completed (paid) rides in a region, it reports true only
 * when at least one RIDER and at least one DRIVER each completed a second paid
 * ride within 7 days of a prior one — in the SAME geography. A second ride
 * outside the window, or in another region, does not count (the region filter is
 * applied at the source, and the window is enforced on the completion gap).
 */
@Injectable()
export class RepeatLiquidityService {
  constructor(
    @Inject(RIDE_REPOSITORY) private readonly repo: RideRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async computeRepeatLiquidity(region?: string): Promise<RepeatLiquidityReport> {
    const geo = region ?? this.env.activeRegion;
    const completed = (await this.repo.completedRidesInRegion(geo)).filter(
      (r): r is RideRow & { completedAt: Date } => r.completedAt !== null,
    );

    const ridersWithRepeat = subjectsWithRepeat(
      completed,
      (r) => r.riderPhone,
    );
    const driversWithRepeat = subjectsWithRepeat(completed, (r) => r.driverId);

    return {
      region: geo,
      windowDays: 7,
      // Bilateral: BOTH sides of the marketplace show a repeat, not just one.
      bilateralRepeatLiquidity:
        ridersWithRepeat.length > 0 && driversWithRepeat.length > 0,
      ridersWithRepeat,
      driversWithRepeat,
      riderRepeatCount: ridersWithRepeat.length,
      driverRepeatCount: driversWithRepeat.length,
      totalCompletedRides: completed.length,
      asOf: this.clock.now().toISOString(),
    };
  }
}

/**
 * The distinct subject keys (rider phones / driver ids) that completed a second
 * paid ride within 7 days of a prior one. Rides are grouped by subject, sorted by
 * completion time, and a subject qualifies if any consecutive gap is <= 7 days.
 */
function subjectsWithRepeat(
  rides: Array<RideRow & { completedAt: Date }>,
  keyOf: (r: RideRow) => string | null,
): string[] {
  const bySubject = new Map<string, Date[]>();
  for (const ride of rides) {
    const key = keyOf(ride);
    if (!key) continue;
    const list = bySubject.get(key) ?? [];
    list.push(ride.completedAt);
    bySubject.set(key, list);
  }

  const repeated: string[] = [];
  for (const [key, times] of bySubject) {
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].getTime() - sorted[i - 1].getTime() <= WEEK_MS) {
        repeated.push(key);
        break;
      }
    }
  }
  return repeated;
}
