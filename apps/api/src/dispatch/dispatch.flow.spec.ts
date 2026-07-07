import {
  DEMO_ROUTE,
  makeHarness,
  offerRide,
  registerLocatedDriver,
  type Harness,
} from '../testing/harness';

// SCRUM-242 dispatch-lite matching: operator lists open requests, ranks nearby
// available drivers, and one-click / greedy assigns exactly one driver — never
// double-assigning — then the driver starts and completes the trip, all within
// the 10-minute budget using fixed pricing (no surge, no ML routing).

const RIDER = DEMO_ROUTE.riderPhone;
// ~0.05deg north of the pickup ≈ 5.5 km away, so it always ranks second.
const FAR_LAT = DEMO_ROUTE.pickup.lat + 0.05;

async function driveToCompletion(
  h: Harness,
  rideId: string,
): Promise<void> {
  const otpView = await h.rides.getOtpForRider(rideId);
  await h.rides.startTrip(rideId, otpView.otp as string);
  await h.rides.complete(rideId);
}

describe('dispatch-lite matching', () => {
  it('lists an offered request in the operator queue', async () => {
    const h = makeHarness();
    const { rideId } = await offerRide(h, RIDER);

    const open = await h.dispatch.listOpenRequests(DEMO_ROUTE.region);
    expect(open.map((r) => r.rideId)).toContain(rideId);
    const req = open.find((r) => r.rideId === rideId);
    expect(req?.pickupLat).toBe(DEMO_ROUTE.pickup.lat);
    expect(req?.status).toBe('offered');
  });

  it('ranks available drivers nearest-first for a request', async () => {
    const h = makeHarness();
    const near = await registerLocatedDriver(h, { phone: '+15550109001' });
    const far = await registerLocatedDriver(h, {
      phone: '+15550109002',
      lat: FAR_LAT,
    });
    const { rideId } = await offerRide(h, RIDER);

    const candidates = await h.dispatch.rankCandidates(rideId);
    expect(candidates.map((c) => c.driverId)).toEqual([near.id, far.id]);
    expect(candidates[0].distanceMeters).toBeLessThan(
      candidates[1].distanceMeters,
    );
  });

  it('greedily assigns the nearest available driver and returns the locked-fare assignment', async () => {
    const h = makeHarness();
    const near = await registerLocatedDriver(h, { phone: '+15550109001' });
    await registerLocatedDriver(h, { phone: '+15550109002', lat: FAR_LAT });
    const { rideId, fareCents } = await offerRide(h, RIDER);

    const assignment = await h.dispatch.assign(rideId);
    expect(assignment.driverId).toBe(near.id);
    expect(assignment.autoAssigned).toBe(true);
    expect(assignment.status).toBe('accepted');
    // Assignment carries pickup, dropoff and the UNCHANGED locked fare.
    expect(assignment.pickup.lat).toBe(DEMO_ROUTE.pickup.lat);
    expect(assignment.dropoff.lat).toBe(DEMO_ROUTE.dropoff.lat);
    expect(assignment.fareCents).toBe(fareCents);

    const ride = await h.repo.getRide(rideId);
    expect(ride?.driverId).toBe(near.id);
    expect(ride?.status).toBe('accepted');
  });

  it('lets the operator assign a specific chosen driver', async () => {
    const h = makeHarness();
    await registerLocatedDriver(h, { phone: '+15550109001' });
    const chosen = await registerLocatedDriver(h, {
      phone: '+15550109002',
      lat: FAR_LAT,
    });
    const { rideId } = await offerRide(h, RIDER);

    // Explicitly pick the FARTHER driver — the operator's choice overrides greedy.
    const assignment = await h.dispatch.assign(rideId, chosen.id);
    expect(assignment.driverId).toBe(chosen.id);
    expect(assignment.autoAssigned).toBe(false);
  });

  it('never double-assigns a driver: a busy driver cannot be assigned to a second request', async () => {
    const h = makeHarness();
    const only = await registerLocatedDriver(h, { phone: '+15550109001' });
    const first = await offerRide(h, RIDER);
    const second = await offerRide(h, '+15550100002');

    await h.dispatch.assign(first.rideId, only.id); // driver now busy

    // Explicit re-assign of the same busy driver is rejected.
    await expect(
      h.dispatch.assign(second.rideId, only.id),
    ).rejects.toThrow();

    // The driver is still on exactly the first ride, never the second.
    expect((await h.repo.getRide(first.rideId))?.driverId).toBe(only.id);
    expect((await h.repo.getRide(second.rideId))?.driverId).toBeNull();
  });

  it('escalates to the human dispatcher when no available driver can be claimed', async () => {
    const h = makeHarness();
    const only = await registerLocatedDriver(h, { phone: '+15550109001' });
    const first = await offerRide(h, RIDER);
    const second = await offerRide(h, '+15550100002');
    await h.dispatch.assign(first.rideId, only.id); // consumes the only driver

    // Greedy assign of the second request finds no free driver -> escalate.
    await expect(h.dispatch.assign(second.rideId)).rejects.toThrow(/escalate/);
  });

  it('offers the next candidate when the nearest driver is already busy', async () => {
    const h = makeHarness();
    const near = await registerLocatedDriver(h, { phone: '+15550109001' });
    const backup = await registerLocatedDriver(h, {
      phone: '+15550109002',
      lat: FAR_LAT,
    });
    const first = await offerRide(h, RIDER);
    const second = await offerRide(h, '+15550100002');

    // Nearest driver takes the first request.
    const a1 = await h.dispatch.assign(first.rideId);
    expect(a1.driverId).toBe(near.id);
    // Second request skips the now-busy nearest driver and gets the backup.
    const a2 = await h.dispatch.assign(second.rideId);
    expect(a2.driverId).toBe(backup.id);
  });

  it('rejects assigning a request that is not open (illegal state transition)', async () => {
    const h = makeHarness();
    const d1 = await registerLocatedDriver(h, { phone: '+15550109001' });
    const d2 = await registerLocatedDriver(h, {
      phone: '+15550109002',
      lat: FAR_LAT,
    });
    const { rideId } = await offerRide(h, RIDER);
    await h.dispatch.assign(rideId, d1.id); // ride is now 'accepted'

    // A second assign attempt is an illegal accepted -> accepted transition.
    await expect(h.dispatch.assign(rideId, d2.id)).rejects.toThrow();
    expect((await h.repo.getRide(rideId))?.driverId).toBe(d1.id);
  });

  it('closes the request -> notified -> accepted -> started loop within the 10-minute budget with fixed pricing', async () => {
    const h = makeHarness();
    const driver = await registerLocatedDriver(h, { phone: '+15550109001' });
    // Anchor the budget at request submission so the quote+offer latency is
    // inside the measured request->started window the AC claims.
    const requestedAt = h.clock.now();
    const { rideId, fareCents } = await offerRide(h, RIDER);

    // Semi-automated dispatch, each step a couple minutes apart.
    h.clock.advanceSeconds(120);
    const assignment = await h.dispatch.assign(rideId);
    h.clock.advanceSeconds(120);
    await driveToCompletion(h, rideId);

    const ride = await h.repo.getRide(rideId);
    expect(ride?.status).toBe('completed');
    // Fixed versioned pricing: the fare never changed through dispatch.
    expect(ride?.fareCents).toBe(fareCents);
    expect(assignment.fareCents).toBe(fareCents);
    // The whole assignment loop closed well inside 10 minutes.
    const elapsedMs =
      (ride?.completedAt as Date).getTime() - requestedAt.getTime();
    expect(elapsedMs).toBeLessThanOrEqual(10 * 60 * 1000);
  });
});
