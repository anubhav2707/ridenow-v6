import { getPlan } from '../common/plan-catalog';
import {
  makeHarness,
  offerRide,
  onboardDemoDriver,
  type Harness,
} from '../testing/harness';

/** Runs the full driver core loop: onboard -> offer -> accept -> OTP start -> complete. */
async function completedPaidRide(
  h: Harness,
): Promise<{ driverId: string; rideId: string; fareCents: number }> {
  const driver = await onboardDemoDriver(h);
  const { rideId, fareCents } = await offerRide(h);
  await h.rides.accept(rideId, driver.id);
  const { otp } = await h.rides.getOtpForRider(rideId);
  await h.rides.startTrip(rideId, otp as string);
  await h.rides.complete(rideId);
  return { driverId: driver.id, rideId, fareCents };
}

describe('driver take-home ledger (SCRUM-241)', () => {
  it('AC-ledger: shows the locked fare, a flat subscription-fee line as the only deduction, and You Keep = 100% — no commission line', async () => {
    const h = makeHarness();
    const { rideId, fareCents } = await completedPaidRide(h);

    const ledger = await h.earnings.tripTakeHomeLedger(rideId);

    // Completed + captured.
    expect(ledger.status).toBe('completed');
    expect(ledger.paid).toBe(true);

    // (1) The locked upfront fare the rider paid.
    expect(ledger.upfrontFareCents).toBe(fareCents);

    // (2) A flat subscription-fee line is the ONLY deduction, at $0 per trip.
    expect(ledger.perTripDeductionCents).toBe(0);
    expect(ledger.subscriptionFeeCents).toBe(
      getPlan('flat_monthly')?.subscriptionFeeCents,
    );
    const feeLine = ledger.lines.find((l) => l.kind === 'subscription_fee');
    expect(feeLine).toBeDefined();
    expect(feeLine?.amountCents).toBe(0);

    // (3) You Keep equals 100% of the upfront fare.
    expect(ledger.youKeepCents).toBe(fareCents);

    // NO percentage commission line, and no commission field at all.
    expect(ledger.lines.some((l) => l.kind === 'platform_commission')).toBe(
      false,
    );
    expect(
      ledger.lines.some((l) => /commission/i.test(l.label)),
    ).toBe(false);
    expect('platformCommissionCents' in ledger).toBe(false);
  });

  it('You Keep is cent-exact with the amount actually credited on the immutable ledger', async () => {
    const h = makeHarness();
    const { rideId } = await completedPaidRide(h);

    const ledger = await h.earnings.tripTakeHomeLedger(rideId);
    const derived = await h.earnings.tripEarnings(rideId);

    // Both derive from the same double-entry postings — no rounding, no drift.
    expect(ledger.youKeepCents).toBe(derived.takeHomeCents);
    expect(ledger.youKeepCents).toBe(ledger.upfrontFareCents);
  });

  it('before capture, You Keep falls back to the locked fare (nothing credited yet)', async () => {
    const h = makeHarness();
    const driver = await onboardDemoDriver(h);
    const { rideId, fareCents } = await offerRide(h);
    await h.rides.accept(rideId, driver.id);

    const ledger = await h.earnings.tripTakeHomeLedger(rideId);
    expect(ledger.paid).toBe(false);
    expect(ledger.youKeepCents).toBe(fareCents);
    expect(ledger.perTripDeductionCents).toBe(0);
  });
});
