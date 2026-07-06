import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { CLOCK, FakeClock } from '../clock/clock';
import { PAYMENT_GATEWAY } from '../payments/payment-gateway';
import { FakePaymentGateway } from '../payments/fake-payment-gateway';

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

describe('paid ride HTTP flow', () => {
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

  async function bookAndPay(): Promise<{ rideId: string; total: number }> {
    const quote = await req<{ id: string; totalCents: number }>(
      baseUrl,
      'POST',
      '/quotes',
      { riderPhone: RIDER, region: REGION, ...ROUTE },
    );
    expect(quote.status).toBe(201);
    const confirm = await req<{ ride: { id: string } }>(baseUrl, 'POST', '/rides', {
      quoteId: quote.body.id,
      riderPhone: RIDER,
      amountCents: 1, // ignored by the server
    });
    expect(confirm.status).toBe(201);
    return { rideId: confirm.body.ride.id, total: quote.body.totalCents };
  }

  it('quotes, confirms (ignoring client amount), completes, and shows a receipt + driver ledger', async () => {
    const driver = await req<{ id: string }>(baseUrl, 'POST', '/drivers', {
      phone: '+15550109001',
      displayName: 'Driver One',
      region: REGION,
    });
    expect(driver.status).toBe(201);

    const { rideId, total } = await bookAndPay();

    // Client amount ignored — receipt reflects the locked quote total.
    const receipt = await req<{
      amountChargedCents: number;
      components: Array<{ amountCents: number }>;
    }>(baseUrl, 'GET', `/rides/${rideId}/receipt`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.amountChargedCents).toBe(total);
    expect(
      receipt.body.components.reduce((a, c) => a + c.amountCents, 0),
    ).toBe(total);

    await req(baseUrl, 'POST', `/rides/${rideId}/accept`, {
      driverId: driver.body.id,
    });
    const complete = await req<{
      earnings: { takeHomeCents: number; platformCommissionCents: number; balanced: boolean };
    }>(baseUrl, 'POST', `/rides/${rideId}/complete`);
    expect(complete.status).toBe(201);
    expect(complete.body.earnings.takeHomeCents).toBe(total);
    expect(complete.body.earnings.platformCommissionCents).toBe(0);
    expect(complete.body.earnings.balanced).toBe(true);

    const ledger = await req<{
      takeHomeCents: number;
      platformCommissionCents: number;
    }>(baseUrl, 'GET', `/drivers/${driver.body.id}/rides/${rideId}/earnings`);
    expect(ledger.body.takeHomeCents).toBe(total);
    expect(ledger.body.platformCommissionCents).toBe(0);
  });

  it('reports rider + driver repeat within 7 days after a second paid ride', async () => {
    const driver = await req<{ id: string }>(baseUrl, 'POST', '/drivers', {
      phone: '+15550109002',
      displayName: 'Driver Two',
      region: REGION,
    });

    const runFullRide = async (): Promise<void> => {
      const { rideId } = await bookAndPay();
      await req(baseUrl, 'POST', `/rides/${rideId}/accept`, {
        driverId: driver.body.id,
      });
      await req(baseUrl, 'POST', `/rides/${rideId}/complete`);
    };

    await runFullRide();
    clock.advanceDays(1); // still within the week
    await runFullRide();

    const rider = await req<{ repeatedWithin7Days: boolean; ridesCount: number }>(
      baseUrl,
      'GET',
      `/riders/${encodeURIComponent(RIDER)}/repeat-status?region=${REGION}`,
    );
    expect(rider.body.ridesCount).toBeGreaterThanOrEqual(2);
    expect(rider.body.repeatedWithin7Days).toBe(true);

    const driverStatus = await req<{ repeatedWithin7Days: boolean }>(
      baseUrl,
      'GET',
      `/drivers/${driver.body.id}/repeat-status?region=${REGION}`,
    );
    expect(driverStatus.body.repeatedWithin7Days).toBe(true);
  });
});

describe('capture failure stays atomic over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(new FakePaymentGateway({ failCapture: true }))
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a 5xx on capture failure and does not mark the ride captured', async () => {
    const driver = await req<{ id: string }>(baseUrl, 'POST', '/drivers', {
      phone: '+15550109003',
      displayName: 'Driver Three',
      region: REGION,
    });
    const quote = await req<{ id: string }>(baseUrl, 'POST', '/quotes', {
      riderPhone: RIDER,
      region: REGION,
      ...ROUTE,
    });
    const confirm = await req<{ ride: { id: string } }>(baseUrl, 'POST', '/rides', {
      quoteId: quote.body.id,
      riderPhone: RIDER,
    });
    const rideId = confirm.body.ride.id;
    await req(baseUrl, 'POST', `/rides/${rideId}/accept`, {
      driverId: driver.body.id,
    });

    const complete = await req(baseUrl, 'POST', `/rides/${rideId}/complete`);
    expect(complete.status).toBeGreaterThanOrEqual(500);

    // The receipt shows the payment was never captured.
    const receipt = await req<{ captured: boolean; status: string }>(
      baseUrl,
      'GET',
      `/rides/${rideId}/receipt`,
    );
    expect(receipt.body.captured).toBe(false);
    expect(receipt.body.status).toBe('accepted');
  });
});
