import {
  BadRequestException,
  ConflictException,
  GoneException,
} from '@nestjs/common';
import {
  makeHarness,
  offerRide,
  onboardDemoDriver,
  type Harness,
} from '../testing/harness';

async function onboardDrivers(h: Harness, n: number) {
  const drivers = [];
  for (let i = 0; i < n; i++) {
    drivers.push(
      await h.drivers.onboard({
        name: `Driver ${i}`,
        phone: `+1555020${i.toString().padStart(4, '0')}`,
        vehicleMake: 'Toyota',
        vehicleModel: 'Prius',
        vehiclePlate: `PLATE-${i}`,
        plan: 'flat_monthly',
      }),
    );
  }
  return drivers;
}

describe('accept + OTP trip start (SCRUM-241)', () => {
  it('accepts an offered ride via one driver, minting a server-side OTP the rider can read (never the driver)', async () => {
    const h = makeHarness();
    const driver = await onboardDemoDriver(h);
    const { rideId, fareCents } = await offerRide(h);

    const accepted = await h.rides.accept(rideId, driver.id);
    expect(accepted.status).toBe('accepted');
    expect(accepted.driverId).toBe(driver.id);
    expect(accepted.fareCents).toBe(fareCents);
    // The OTP is NOT on the driver-facing view.
    expect((accepted as unknown as Record<string, unknown>).otp).toBeUndefined();

    // The rider CAN read the OTP from their own app.
    const otpView = await h.rides.getOtpForRider(rideId);
    expect(otpView.otp).toMatch(/^\d{6}$/);
    expect(otpView.status).toBe('accepted');
  });

  it('AC-race: with N drivers accepting concurrently, exactly one wins and the ride holds exactly one driver_id', async () => {
    const h = makeHarness();
    const drivers = await onboardDrivers(h, 8);
    const { rideId } = await offerRide(h);

    const results = await Promise.allSettled(
      drivers.map((d) => h.rides.accept(rideId, d.id)),
    );
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(drivers.length - 1);
    // Every loser is a 409 Conflict.
    for (const loser of losers as PromiseRejectedResult[]) {
      expect(loser.reason).toBeInstanceOf(ConflictException);
    }
    // The ride row holds exactly the one winning driver.
    const ride = await h.repo.getRide(rideId);
    const winningDriverId = (
      winners[0] as PromiseFulfilledResult<{ driverId: string | null }>
    ).value.driverId;
    expect(ride?.driverId).toBe(winningDriverId);
    expect(drivers.map((d) => d.id)).toContain(ride?.driverId);
  });

  it('AC-offer-expiry: an offer past its TTL cannot be accepted and stays unassigned', async () => {
    const h = makeHarness();
    const driver = await onboardDemoDriver(h);
    const { rideId } = await offerRide(h);

    h.clock.advanceSeconds(5 * 60 + 1); // past the offer TTL

    await expect(h.rides.accept(rideId, driver.id)).rejects.toBeInstanceOf(
      GoneException,
    );
    const ride = await h.repo.getRide(rideId);
    expect(ride?.status).toBe('offered');
    expect(ride?.driverId).toBeNull();
  });

  it('AC-otp-start: the correct OTP transitions the trip to in_progress and consumes the code (single-use)', async () => {
    const h = makeHarness();
    const driver = await onboardDemoDriver(h);
    const { rideId } = await offerRide(h);
    await h.rides.accept(rideId, driver.id);

    const { otp } = await h.rides.getOtpForRider(rideId);
    const started = await h.rides.startTrip(rideId, otp as string);
    expect(started.status).toBe('in_progress');
    expect(started.startedAt).toBeTruthy();

    // Single-use: the OTP is no longer revealed and cannot start again.
    const afterView = await h.rides.getOtpForRider(rideId);
    expect(afterView.otp).toBeNull();
    await expect(h.rides.startTrip(rideId, otp as string)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const ride = await h.repo.getRide(rideId);
    expect(ride?.otpConsumedAt).not.toBeNull();
  });

  it('AC-otp-wrong: a wrong OTP is rejected, increments attempts, and locks out after the maximum', async () => {
    const h = makeHarness();
    const driver = await onboardDemoDriver(h);
    const { rideId } = await offerRide(h);
    await h.rides.accept(rideId, driver.id);
    const { otp } = await h.rides.getOtpForRider(rideId);
    const wrong = otp === '000000' ? '111111' : '000000';

    // Five wrong attempts, each rejected and each incrementing the counter.
    for (let i = 1; i <= 5; i++) {
      await expect(h.rides.startTrip(rideId, wrong)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const ride = await h.repo.getRide(rideId);
      expect(ride?.otpAttempts).toBe(i);
    }

    // Now even the CORRECT code is locked out.
    await expect(
      h.rides.startTrip(rideId, otp as string),
    ).rejects.toThrow(/locked out/);
    const ride = await h.repo.getRide(rideId);
    expect(ride?.status).toBe('accepted');
    expect(ride?.otpConsumedAt).toBeNull();
  });

  it('AC-otp-expiry: an expired OTP is rejected even if the code is correct', async () => {
    const h = makeHarness();
    const driver = await onboardDemoDriver(h);
    const { rideId } = await offerRide(h);
    await h.rides.accept(rideId, driver.id);
    const { otp } = await h.rides.getOtpForRider(rideId);

    h.clock.advanceSeconds(5 * 60 + 1); // past the OTP TTL

    await expect(
      h.rides.startTrip(rideId, otp as string),
    ).rejects.toThrow(/expired/);
    // The rider view no longer reveals the (now expired) code either.
    expect((await h.rides.getOtpForRider(rideId)).otp).toBeNull();
  });

  it('cannot start a trip on a ride that was never accepted', async () => {
    const h = makeHarness();
    const { rideId } = await offerRide(h);
    await expect(h.rides.startTrip(rideId, '123456')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
