import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { CLOCK, FakeClock } from '../clock/clock';

const REGION = 'geo-1';
const RIDER = '+15550100999';
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

describe('driver onboarding + trip lifecycle (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const clock = new FakeClock(new Date('2026-07-01T00:00:00.000Z'));

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

  it('onboards a driver (activated, no KYC gate) via POST /drivers/onboarding', async () => {
    const res = await req<{ id: string; active: boolean; plan: string }>(
      baseUrl,
      'POST',
      '/drivers/onboarding',
      {
        name: 'Highway Hank',
        phone: '+15550103001',
        vehicleMake: 'Ford',
        vehicleModel: 'Focus',
        vehiclePlate: 'HANK-1',
        plan: 'flat_monthly',
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.active).toBe(true);
    expect(res.body.plan).toBe('flat_monthly');
  });

  it('rejects onboarding with a missing required field (400)', async () => {
    const res = await req<{ statusCode: number; fields?: string[] }>(
      baseUrl,
      'POST',
      '/drivers/onboarding',
      {
        name: 'No Plate Nan',
        phone: '+15550103002',
        vehicleMake: 'Ford',
        vehicleModel: 'Focus',
        // vehiclePlate omitted
        plan: 'flat_monthly',
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain('vehiclePlate');
  });

  it('runs accept -> rider OTP -> driver start -> GPS ping -> complete -> take-home ledger', async () => {
    const driver = await req<{ id: string }>(
      baseUrl,
      'POST',
      '/drivers/onboarding',
      {
        name: 'Loop Lena',
        phone: '+15550103003',
        vehicleMake: 'Tesla',
        vehicleModel: 'Model 3',
        vehiclePlate: 'LENA-1',
        plan: 'flat_monthly',
      },
    );
    const driverId = driver.body.id;

    // Rider books + pays -> ride is offered.
    const quote = await req<{ id: string; totalCents: number }>(
      baseUrl,
      'POST',
      '/quotes',
      { riderPhone: RIDER, region: REGION, ...ROUTE },
    );
    const total = quote.body.totalCents;
    const confirm = await req<{ ride: { id: string; status: string } }>(
      baseUrl,
      'POST',
      '/rides',
      { quoteId: quote.body.id, riderPhone: RIDER },
    );
    const rideId = confirm.body.ride.id;
    expect(confirm.body.ride.status).toBe('offered');

    // Driver accepts (mints the OTP server-side).
    const accept = await req<{ status: string; driverId: string }>(
      baseUrl,
      'POST',
      `/rides/${rideId}/accept`,
      { driverId },
    );
    expect(accept.status).toBe(201);
    expect(accept.body.status).toBe('accepted');
    expect(accept.body.driverId).toBe(driverId);

    // Rider reads the OTP from their app.
    const otpRes = await req<{ otp: string }>(
      baseUrl,
      'GET',
      `/riders/rides/${rideId}/otp`,
    );
    expect(otpRes.body.otp).toMatch(/^\d{6}$/);

    // Driver enters it -> trip in progress.
    const start = await req<{ status: string }>(
      baseUrl,
      'POST',
      `/rides/${rideId}/start`,
      { otp: otpRes.body.otp },
    );
    expect(start.status).toBe(201);
    expect(start.body.status).toBe('in_progress');

    // GPS ping persists against the trip.
    const ping = await req<{ rideId: string; seq: number }>(
      baseUrl,
      'POST',
      `/rides/${rideId}/pings`,
      { lat: 37.775, lng: -122.4195 },
    );
    expect(ping.status).toBe(201);
    expect(ping.body.rideId).toBe(rideId);
    const pings = await req<Array<{ seq: number }>>(
      baseUrl,
      'GET',
      `/rides/${rideId}/pings`,
    );
    expect(pings.body).toHaveLength(1);

    // Complete + capture, then view the take-home ledger.
    const complete = await req<{ ride: { status: string } }>(
      baseUrl,
      'POST',
      `/rides/${rideId}/complete`,
    );
    expect(complete.status).toBe(201);

    const ledger = await req<{
      upfrontFareCents: number;
      perTripDeductionCents: number;
      youKeepCents: number;
      lines: Array<{ kind: string }>;
    }>(baseUrl, 'GET', `/drivers/${driverId}/rides/${rideId}/ledger`);
    expect(ledger.body.upfrontFareCents).toBe(total);
    expect(ledger.body.youKeepCents).toBe(total);
    expect(ledger.body.perTripDeductionCents).toBe(0);
    expect(
      ledger.body.lines.some((l) => l.kind === 'platform_commission'),
    ).toBe(false);
    expect(ledger.body.lines.some((l) => l.kind === 'subscription_fee')).toBe(
      true,
    );
  });
});
