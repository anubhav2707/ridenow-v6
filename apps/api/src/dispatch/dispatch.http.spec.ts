import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { CLOCK, FakeClock } from '../clock/clock';

const REGION = 'geo-1';
const RIDER = '+15550100777';
const ROUTE = {
  pickup: { label: 'Downtown', lat: 37.7749, lng: -122.4194 },
  dropoff: { label: 'Airport', lat: 37.6213, lng: -122.379 },
};

interface Res<T> {
  status: number;
  body: T;
}

async function req<T>(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Res<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as T) : (undefined as T),
  };
}

describe('operator dispatch HTTP flow', () => {
  let app: INestApplication;
  let baseUrl: string;
  const clock = new FakeClock(new Date('2026-06-01T00:00:00.000Z'));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function bookRide(rider = RIDER): Promise<{ rideId: string; total: number }> {
    const quote = await req<{ id: string; totalCents: number }>(
      baseUrl,
      'POST',
      '/quotes',
      { riderPhone: rider, region: REGION, ...ROUTE },
    );
    const confirm = await req<{ ride: { id: string } }>(baseUrl, 'POST', '/rides', {
      quoteId: quote.body.id,
      riderPhone: rider,
    });
    return { rideId: confirm.body.ride.id, total: quote.body.totalCents };
  }

  it('onboards a located driver, assigns via the console, and drives to completion', async () => {
    const driver = await req<{ id: string }>(baseUrl, 'POST', '/drivers', {
      phone: '+15550109101',
      displayName: 'Console Driver',
      region: REGION,
    });
    expect(driver.status).toBe(201);
    const loc = await req(baseUrl, 'POST', `/dispatch/drivers/${driver.body.id}/location`, {
      lat: ROUTE.pickup.lat,
      lng: ROUTE.pickup.lng,
    });
    expect(loc.status).toBe(201);

    const { rideId, total } = await bookRide();

    // The request shows up in the operator queue.
    const open = await req<Array<{ rideId: string }>>(
      baseUrl,
      'GET',
      `/dispatch/open-requests?region=${REGION}`,
    );
    expect(open.body.map((r) => r.rideId)).toContain(rideId);

    // Ranked candidates surface the nearby driver.
    const candidates = await req<Array<{ driverId: string; distanceMeters: number }>>(
      baseUrl,
      'GET',
      `/dispatch/rides/${rideId}/candidates`,
    );
    expect(candidates.body.map((c) => c.driverId)).toContain(driver.body.id);

    // One-click assign locks in the driver at the unchanged fare.
    const assign = await req<{
      driverId: string;
      status: string;
      fareCents: number;
      dropoff: { lat: number };
    }>(baseUrl, 'POST', `/dispatch/rides/${rideId}/assign`, {});
    expect(assign.status).toBe(201);
    expect(assign.body.driverId).toBe(driver.body.id);
    expect(assign.body.status).toBe('accepted');
    expect(assign.body.fareCents).toBe(total);
    expect(assign.body.dropoff.lat).toBe(ROUTE.dropoff.lat);

    // Rider reads the OTP; driver starts and completes the trip.
    const otp = await req<{ otp: string }>(
      baseUrl,
      'GET',
      `/riders/rides/${rideId}/otp`,
    );
    expect(otp.body.otp).toMatch(/^\d{6}$/);
    const start = await req(baseUrl, 'POST', `/rides/${rideId}/start`, {
      otp: otp.body.otp,
    });
    expect(start.status).toBe(201);
    const complete = await req<{ earnings: { takeHomeCents: number } }>(
      baseUrl,
      'POST',
      `/rides/${rideId}/complete`,
    );
    expect(complete.status).toBe(201);
    // 100% take-home at the locked fare (differentiation preserved through dispatch).
    expect(complete.body.earnings.takeHomeCents).toBe(total);
  });

  it('reports bilateral repeat liquidity once a rider and driver each repeat in-window', async () => {
    const driver = await req<{ id: string }>(baseUrl, 'POST', '/drivers', {
      phone: '+15550109102',
      displayName: 'Repeat Driver',
      region: REGION,
    });
    await req(baseUrl, 'POST', `/dispatch/drivers/${driver.body.id}/location`, {
      lat: ROUTE.pickup.lat,
      lng: ROUTE.pickup.lng,
    });
    const rider = '+15550100888';

    const runRide = async (): Promise<void> => {
      const { rideId } = await bookRide(rider);
      await req(baseUrl, 'POST', `/dispatch/rides/${rideId}/assign`, {
        driverId: driver.body.id,
      });
      const otp = await req<{ otp: string }>(
        baseUrl,
        'GET',
        `/riders/rides/${rideId}/otp`,
      );
      await req(baseUrl, 'POST', `/rides/${rideId}/start`, { otp: otp.body.otp });
      await req(baseUrl, 'POST', `/rides/${rideId}/complete`);
    };

    await runRide();
    clock.advanceDays(2); // within the 7-day window
    await runRide();

    const report = await req<{
      bilateralRepeatLiquidity: boolean;
      ridersWithRepeat: string[];
      driversWithRepeat: string[];
    }>(baseUrl, 'GET', `/dispatch/repeat-liquidity?region=${REGION}`);
    expect(report.body.bilateralRepeatLiquidity).toBe(true);
    expect(report.body.ridersWithRepeat).toContain(rider);
    expect(report.body.driversWithRepeat).toContain(driver.body.id);
  });
});
