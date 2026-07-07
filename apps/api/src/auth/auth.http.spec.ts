import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { CLOCK, FakeClock } from '../clock/clock';
import { FakePaymentGateway } from '../payments/fake-payment-gateway';
import { PAYMENT_GATEWAY } from '../payments/payment-gateway';
import { SmsService } from './sms.service';

const REGION = 'geo-1';
const PHONE = '+15550100888';
const SAVED_CARD = 'pm_card_visa';
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
  opts: { body?: unknown; token?: string } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as T) : (undefined as T),
  };
}

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; role: string };
}
interface QuoteBody {
  id: string;
  totalCents: number;
  currency: string;
  expiresAt: string;
  createdAt: string;
  surge: { applied: boolean; multiplier: number };
  locked: boolean;
  components: Array<{ kind: string; amountCents: number }>;
}

describe('SCRUM-240 rider signup → quote → pay → repeat (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const clock = new FakeClock(new Date('2026-06-01T00:00:00.000Z'));
  const gateway = new FakePaymentGateway();
  // Capturing SMS sender: records the code that would have been texted so the
  // test can complete verification. The raw code still never crosses the API.
  const codes = new Map<string, string>();
  const smsStub: Pick<SmsService, 'sendLoginCode'> = {
    async sendLoginCode(phone: string, code: string) {
      codes.set(phone, code);
      return 'console';
    },
  };

  const prevSendMax = process.env.OTP_SEND_MAX;

  beforeAll(async () => {
    // This suite signs the same number in across several tests; raise the send
    // cap so the anti-toll-fraud limit (exercised separately in auth.flow.spec)
    // doesn't make the end-to-end flow order-fragile.
    process.env.OTP_SEND_MAX = '100';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(PAYMENT_GATEWAY)
      .useValue(gateway)
      .overrideProvider(SmsService)
      .useValue(smsStub)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    if (prevSendMax === undefined) delete process.env.OTP_SEND_MAX;
    else process.env.OTP_SEND_MAX = prevSendMax;
  });

  async function signIn(phone = PHONE): Promise<Session> {
    const request = await req<Record<string, unknown>>(
      baseUrl,
      'POST',
      '/auth/otp/request',
      { body: { phone } },
    );
    expect(request.status).toBe(200);
    // AC: the raw code is never returned in the response.
    expect(request.body).not.toHaveProperty('code');

    const code = codes.get(phone);
    expect(code).toMatch(/^\d{6}$/);
    const verify = await req<Session>(baseUrl, 'POST', '/auth/otp/verify', {
      body: { phone, code },
    });
    expect(verify.status).toBe(200);
    expect(verify.body.user.role).toBe('rider');
    return verify.body;
  }

  async function quote(token: string): Promise<QuoteBody> {
    const res = await req<QuoteBody>(baseUrl, 'POST', '/quotes', {
      token,
      body: { riderPhone: PHONE, region: REGION, ...ROUTE },
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('AC1-2: passwordless signup issues rider tokens and creates the account', async () => {
    const session = await signIn();
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.user.phone).toBe(PHONE);
  });

  it('requires authentication to save a card, then saves it for the account', async () => {
    const session = await signIn();
    // Unauthenticated save is rejected.
    const noAuth = await req(baseUrl, 'POST', '/payment-methods', {
      body: { stripePaymentMethodId: SAVED_CARD },
    });
    expect(noAuth.status).toBe(401);

    const saved = await req<{ isDefault: boolean; last4: string | null }>(
      baseUrl,
      'POST',
      '/payment-methods',
      { token: session.accessToken, body: { stripePaymentMethodId: SAVED_CARD, last4: '4242' } },
    );
    expect(saved.status).toBe(201);
    expect(saved.body.isDefault).toBe(true);
    expect(saved.body.last4).toBe('4242');
  });

  it('AC5: the quote is a locked, itemized, no-surge breakdown with a 10-minute expiry', async () => {
    const session = await signIn();
    const q = await quote(session.accessToken);

    expect(Number.isInteger(q.totalCents)).toBe(true);
    const kinds = q.components.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['base', 'distance', 'time']));
    expect(q.components.reduce((a, c) => a + c.amountCents, 0)).toBe(q.totalCents);
    // Explicit no-surge indication + locked flag.
    expect(q.surge.applied).toBe(false);
    expect(q.surge.multiplier).toBe(1);
    expect(q.locked).toBe(true);
    // expiresAt is exactly 10 minutes past createdAt.
    const window =
      new Date(q.expiresAt).getTime() - new Date(q.createdAt).getTime();
    expect(window).toBe(10 * 60 * 1000);
  });

  it('AC6-8: confirm authorizes the locked total on the saved card, complete captures exactly that, receipt matches', async () => {
    const session = await signIn();
    await req(baseUrl, 'POST', '/payment-methods', {
      token: session.accessToken,
      body: { stripePaymentMethodId: SAVED_CARD, last4: '4242' },
    });
    const driver = await req<{ id: string }>(baseUrl, 'POST', '/drivers', {
      body: { phone: '+15550109801', displayName: 'Driver A', region: REGION },
    });
    const q = await quote(session.accessToken);

    // Confirm — the client-sent amount is a lie and must be ignored.
    const confirm = await req<{
      ride: { id: string; paymentIntentId: string };
      receipt: { amountChargedCents: number };
    }>(baseUrl, 'POST', '/rides', {
      token: session.accessToken,
      body: { quoteId: q.id, riderPhone: PHONE, amountCents: 1 },
    });
    expect(confirm.status).toBe(201);
    expect(confirm.body.receipt.amountChargedCents).toBe(q.totalCents);

    // AC6: the PaymentIntent was authorized against the rider's SAVED card, for
    // exactly the locked total.
    const intent = gateway.getIntent(confirm.body.ride.paymentIntentId);
    expect(intent?.paymentMethodId).toBe(SAVED_CARD);
    expect(intent?.amountCents).toBe(q.totalCents);

    // AC6: a second confirm against the now-consumed quote is rejected.
    const reconfirm = await req(baseUrl, 'POST', '/rides', {
      token: session.accessToken,
      body: { quoteId: q.id, riderPhone: PHONE },
    });
    expect(reconfirm.status).toBeGreaterThanOrEqual(409);

    const rideId = confirm.body.ride.id;
    await req(baseUrl, 'POST', `/rides/${rideId}/accept`, {
      body: { driverId: driver.body.id },
    });
    const complete = await req<{ ride: { fareCents: number } }>(
      baseUrl,
      'POST',
      `/rides/${rideId}/complete`,
    );
    expect(complete.status).toBe(201);

    // AC7/AC8: captured EXACTLY the locked total — no more, no less.
    expect(gateway.getIntent(confirm.body.ride.paymentIntentId)?.status).toBe(
      'captured',
    );
    expect(gateway.getIntent(confirm.body.ride.paymentIntentId)?.amountCents).toBe(
      q.totalCents,
    );

    // AC7: the receipt carries the identical itemized line items.
    const receipt = await req<{
      amountChargedCents: number;
      captured: boolean;
      components: Array<{ kind: string; amountCents: number }>;
    }>(baseUrl, 'GET', `/rides/${rideId}/receipt`);
    expect(receipt.body.captured).toBe(true);
    expect(receipt.body.amountChargedCents).toBe(q.totalCents);
    expect(receipt.body.components.map((c) => c.kind)).toEqual(
      q.components.map((c) => c.kind),
    );
    expect(
      receipt.body.components.reduce((a, c) => a + c.amountCents, 0),
    ).toBe(q.totalCents);
  });

  it('AC (repeat): a second ride within 7 days reuses the account + saved card via refresh — no re-signup, no re-entered card', async () => {
    const session = await signIn();
    await req(baseUrl, 'POST', '/payment-methods', {
      token: session.accessToken,
      body: { stripePaymentMethodId: SAVED_CARD, last4: '4242' },
    });
    const driver = await req<{ id: string }>(baseUrl, 'POST', '/drivers', {
      body: { phone: '+15550109802', displayName: 'Driver B', region: REGION },
    });

    const runRide = async (token: string): Promise<string> => {
      const q = await quote(token);
      const confirm = await req<{ ride: { id: string; paymentIntentId: string } }>(
        baseUrl,
        'POST',
        '/rides',
        { token, body: { quoteId: q.id, riderPhone: PHONE } },
      );
      // Saved card used again — no card was re-entered.
      expect(gateway.getIntent(confirm.body.ride.paymentIntentId)?.paymentMethodId).toBe(
        SAVED_CARD,
      );
      const rideId = confirm.body.ride.id;
      await req(baseUrl, 'POST', `/rides/${rideId}/accept`, {
        body: { driverId: driver.body.id },
      });
      await req(baseUrl, 'POST', `/rides/${rideId}/complete`);
      return rideId;
    };

    await runRide(session.accessToken);

    // A day later the access token has expired — but the rider stays signed in by
    // rotating the refresh token (no OTP re-entry).
    clock.advanceDays(1);
    const refreshed = await req<{ accessToken: string }>(
      baseUrl,
      'POST',
      '/auth/refresh',
      { body: { refreshToken: session.refreshToken } },
    );
    expect(refreshed.status).toBe(200);
    await runRide(refreshed.body.accessToken);

    const repeat = await req<{ repeatedWithin7Days: boolean; ridesCount: number }>(
      baseUrl,
      'GET',
      `/riders/${encodeURIComponent(PHONE)}/repeat-status?region=${REGION}`,
    );
    expect(repeat.body.ridesCount).toBeGreaterThanOrEqual(2);
    expect(repeat.body.repeatedWithin7Days).toBe(true);
  });
});
