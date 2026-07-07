import {
  DEMO_ROUTE,
  makeHarness,
  registerLocatedDriver,
  runPaidRide,
  type Harness,
} from '../testing/harness';

// SCRUM-242 kill metric: bilateral repeat liquidity in one geography — at least
// one rider AND one driver each completing a second paid ride within 7 days, in
// the same region. These tests pin exactly when it flips true.

const RIDER_A = '+15550100001';
const RIDER_B = '+15550100002';

async function completedRide(
  h: Harness,
  driverId: string,
  riderPhone: string,
): Promise<void> {
  await runPaidRide(h, driverId, riderPhone);
}

describe('bilateral repeat-liquidity report', () => {
  it('is true when a rider AND a driver each repeat within 7 days in the region', async () => {
    const h = makeHarness();
    const driver = await registerLocatedDriver(h, { phone: '+15550109001' });

    // Same rider and same driver each complete a second paid ride 2 days later.
    await completedRide(h, driver.id, RIDER_A);
    h.clock.advanceDays(2);
    await completedRide(h, driver.id, RIDER_A);

    const report = await h.repeatLiquidity.computeRepeatLiquidity(
      DEMO_ROUTE.region,
    );
    expect(report.bilateralRepeatLiquidity).toBe(true);
    expect(report.ridersWithRepeat).toContain(RIDER_A);
    expect(report.driversWithRepeat).toContain(driver.id);
    expect(report.totalCompletedRides).toBe(2);
  });

  it('is FALSE when only the rider repeats but no driver does', async () => {
    const h = makeHarness();
    const driver1 = await registerLocatedDriver(h, { phone: '+15550109001' });
    const driver2 = await registerLocatedDriver(h, { phone: '+15550109002' });

    // One rider takes two rides in-window, but with two DIFFERENT drivers — so no
    // single driver has a repeat. Bilateral liquidity must not be claimed.
    await completedRide(h, driver1.id, RIDER_A);
    h.clock.advanceDays(1);
    await completedRide(h, driver2.id, RIDER_A);

    const report = await h.repeatLiquidity.computeRepeatLiquidity(
      DEMO_ROUTE.region,
    );
    expect(report.ridersWithRepeat).toContain(RIDER_A);
    expect(report.driversWithRepeat).toHaveLength(0);
    expect(report.bilateralRepeatLiquidity).toBe(false);
  });

  it('does NOT count a second ride outside the 7-day window', async () => {
    const h = makeHarness();
    const driver = await registerLocatedDriver(h, { phone: '+15550109001' });

    await completedRide(h, driver.id, RIDER_A);
    h.clock.advanceDays(8); // just past the window
    await completedRide(h, driver.id, RIDER_A);

    const report = await h.repeatLiquidity.computeRepeatLiquidity(
      DEMO_ROUTE.region,
    );
    expect(report.totalCompletedRides).toBe(2);
    expect(report.ridersWithRepeat).toHaveLength(0);
    expect(report.driversWithRepeat).toHaveLength(0);
    expect(report.bilateralRepeatLiquidity).toBe(false);
  });

  it('only considers the requested geography (a ride elsewhere does not count)', async () => {
    const h = makeHarness();
    const driver = await registerLocatedDriver(h, { phone: '+15550109001' });

    // Two in-window rides in geo-1 for the same rider+driver => bilateral repeat.
    await completedRide(h, driver.id, RIDER_A);
    h.clock.advanceDays(1);
    await completedRide(h, driver.id, RIDER_A);

    // A different geography reports no cohort at all.
    const other = await h.repeatLiquidity.computeRepeatLiquidity('geo-2');
    expect(other.totalCompletedRides).toBe(0);
    expect(other.bilateralRepeatLiquidity).toBe(false);

    const target = await h.repeatLiquidity.computeRepeatLiquidity('geo-1');
    expect(target.bilateralRepeatLiquidity).toBe(true);
  });

  it('needs BOTH sides: a lone repeating rider with a lone repeating driver on separate riders still counts only when each side has a repeat', async () => {
    const h = makeHarness();
    const driverX = await registerLocatedDriver(h, { phone: '+15550109001' });
    const driverY = await registerLocatedDriver(h, { phone: '+15550109002' });

    // Driver X serves rider A twice (driver repeat + rider repeat) => bilateral.
    await completedRide(h, driverX.id, RIDER_A);
    h.clock.advanceDays(1);
    await completedRide(h, driverX.id, RIDER_A);
    // A one-off unrelated ride by driver Y for rider B — no repeat contributed.
    await completedRide(h, driverY.id, RIDER_B);

    const report = await h.repeatLiquidity.computeRepeatLiquidity('geo-1');
    expect(report.ridersWithRepeat).toEqual([RIDER_A]);
    expect(report.driversWithRepeat).toEqual([driverX.id]);
    expect(report.bilateralRepeatLiquidity).toBe(true);
  });
});
