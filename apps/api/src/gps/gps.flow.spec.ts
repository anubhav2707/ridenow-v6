import { ConflictException } from '@nestjs/common';
import {
  makeHarness,
  offerRide,
  onboardDemoDriver,
  type Harness,
} from '../testing/harness';

/** Drives a ride all the way to 'in_progress' so it can accept GPS pings. */
async function inProgressRide(h: Harness): Promise<string> {
  const driver = await onboardDemoDriver(h);
  const { rideId } = await offerRide(h);
  await h.rides.accept(rideId, driver.id);
  const { otp } = await h.rides.getOtpForRider(rideId);
  await h.rides.startTrip(rideId, otp as string);
  return rideId;
}

describe('GPS ping ingest (SCRUM-241)', () => {
  it('persists each coordinate + timestamp against the trip for pings at a <=10s interval', async () => {
    const h = makeHarness();
    const rideId = await inProgressRide(h);

    // A route sampled once every 10 seconds (the required max interval).
    const base = h.clock.now().getTime();
    const fixes = [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 37.775, lng: -122.4195 },
      { lat: 37.7752, lng: -122.4197 },
      { lat: 37.7755, lng: -122.42 },
    ];

    for (let i = 0; i < fixes.length; i++) {
      const recordedAt = new Date(base + i * 10_000).toISOString();
      h.clock.set(new Date(base + i * 10_000));
      const ping = await h.gps.record(rideId, { ...fixes[i], recordedAt });
      expect(ping.rideId).toBe(rideId);
      expect(ping.lat).toBe(fixes[i].lat);
      expect(ping.lng).toBe(fixes[i].lng);
      expect(ping.recordedAt).toBe(recordedAt);
      expect(ping.seq).toBe(i + 1);
    }

    // Every fix is persisted and attributed to the trip, in order.
    const stored = await h.gps.list(rideId);
    expect(stored).toHaveLength(fixes.length);
    expect(stored.map((p) => [p.lat, p.lng])).toEqual(
      fixes.map((f) => [f.lat, f.lng]),
    );
    // Consecutive fixes are no more than 10s apart.
    for (let i = 1; i < stored.length; i++) {
      const gap =
        new Date(stored[i].recordedAt).getTime() -
        new Date(stored[i - 1].recordedAt).getTime();
      expect(gap).toBeLessThanOrEqual(10_000);
    }

    // The ride carries the hot "latest position" for the last fix.
    const ride = await h.repo.getRide(rideId);
    expect(ride?.lastLat).toBe(fixes[fixes.length - 1].lat);
    expect(ride?.lastLng).toBe(fixes[fixes.length - 1].lng);
    expect(ride?.lastPingAt).not.toBeNull();
  });

  it('defaults recordedAt to server time when the client omits it', async () => {
    const h = makeHarness();
    const rideId = await inProgressRide(h);
    const ping = await h.gps.record(rideId, { lat: 37.77, lng: -122.41 });
    expect(ping.recordedAt).toBe(h.clock.now().toISOString());
  });

  it('rejects pings before the trip is in progress (offered / accepted)', async () => {
    const h = makeHarness();
    const driver = await onboardDemoDriver(h);
    const { rideId } = await offerRide(h);

    // Offered: no pings yet.
    await expect(
      h.gps.record(rideId, { lat: 1, lng: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Accepted but not started: still no pings.
    await h.rides.accept(rideId, driver.id);
    await expect(
      h.gps.record(rideId, { lat: 1, lng: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(await h.gps.list(rideId)).toHaveLength(0);
  });
});
