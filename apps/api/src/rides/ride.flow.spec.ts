import { randomUUID } from 'node:crypto';
import { sumCents } from '../money/money';
import { FakePaymentGateway } from '../payments/fake-payment-gateway';
import { PaymentGatewayError } from '../payments/payment-gateway';
import { LedgerService } from '../ledger/ledger.service';
import { KINDS } from '../ledger/ledger.types';
import {
  DEMO_ROUTE,
  makeHarness,
  registerDemoDriver,
  runPaidRide,
} from '../testing/harness';

// Counts authorize calls so we can prove the gateway is never touched when a
// confirm is rejected up front.
class CountingGateway extends FakePaymentGateway {
  authorizeCount = 0;
  override async authorize(input: Parameters<FakePaymentGateway['authorize']>[0]) {
    this.authorizeCount += 1;
    return super.authorize(input);
  }
}

async function quoteDemo(h: ReturnType<typeof makeHarness>, phone = DEMO_ROUTE.riderPhone) {
  return h.quotes.createQuote({
    riderPhone: phone,
    region: DEMO_ROUTE.region,
    pickup: DEMO_ROUTE.pickup,
    dropoff: DEMO_ROUTE.dropoff,
  });
}

describe('paid ride flow', () => {
  it('AC1: a quote locks a total in integer cents with itemized components that sum to it, persisted with a TTL and id', async () => {
    const h = makeHarness();
    const quote = await quoteDemo(h);

    expect(quote.id).toBeTruthy();
    expect(Number.isInteger(quote.totalCents)).toBe(true);
    expect(quote.components.length).toBeGreaterThan(0);
    expect(sumCents(quote.components.map((c) => c.amountCents))).toBe(
      quote.totalCents,
    );
    // Persisted with a TTL and readable back by id.
    expect(new Date(quote.expiresAt).getTime()).toBeGreaterThan(
      new Date(quote.createdAt).getTime(),
    );
    const reread = await h.quotes.getQuoteView(quote.id);
    expect(reread.totalCents).toBe(quote.totalCents);
  });

  it('AC2: confirm charges the persisted quote total and IGNORES a client-supplied amount; receipt shows the same breakdown', async () => {
    const h = makeHarness();
    const quote = await quoteDemo(h);

    const result = await h.rides.confirm({
      quoteId: quote.id,
      riderPhone: DEMO_ROUTE.riderPhone,
      amountCents: 1, // a lie — must be ignored
    });

    expect(result.ride.fareCents).toBe(quote.totalCents);
    expect(result.receipt.amountChargedCents).toBe(quote.totalCents);
    // Same itemized breakdown that composed the total.
    expect(sumCents(result.receipt.components.map((c) => c.amountCents))).toBe(
      quote.totalCents,
    );
    const payment = await h.repo.getPaymentByRide(result.ride.id);
    expect(payment?.amountCents).toBe(quote.totalCents);
    expect(payment?.status).toBe('authorized');
  });

  it('AC3: an expired quote is rejected with NO authorization and NO ledger row', async () => {
    const gateway = new CountingGateway();
    const h = makeHarness({ gateway });
    const quote = await quoteDemo(h);

    // Move past the TTL.
    h.clock.advanceSeconds(h.env.quoteTtlSeconds + 1);

    await expect(
      h.rides.confirm({ quoteId: quote.id, riderPhone: DEMO_ROUTE.riderPhone }),
    ).rejects.toThrow(/expired|used/);

    expect(gateway.authorizeCount).toBe(0);
    // Quote was never consumed and no ride/ledger exists.
    const reread = await h.repo.getQuote(quote.id);
    expect(reread?.quote.status).toBe('active');
  });

  it('AC3b: a consumed quote cannot be used a second time', async () => {
    const h = makeHarness();
    const quote = await quoteDemo(h);
    await h.rides.confirm({
      quoteId: quote.id,
      riderPhone: DEMO_ROUTE.riderPhone,
    });
    await expect(
      h.rides.confirm({ quoteId: quote.id, riderPhone: DEMO_ROUTE.riderPhone }),
    ).rejects.toThrow(/expired|used/);
  });

  it('AC4: a capture failure writes NO capture payment state and NO ledger entry (atomic)', async () => {
    const gateway = new FakePaymentGateway({ failCapture: true });
    const h = makeHarness({ gateway });
    const driver = await registerDemoDriver(h);
    const quote = await quoteDemo(h);
    const confirmed = await h.rides.confirm({
      quoteId: quote.id,
      riderPhone: DEMO_ROUTE.riderPhone,
    });
    await h.rides.accept(confirmed.ride.id, driver.id);

    await expect(h.rides.complete(confirmed.ride.id)).rejects.toBeInstanceOf(
      PaymentGatewayError,
    );

    // Payment never advanced to captured.
    const payment = await h.repo.getPaymentByRide(confirmed.ride.id);
    expect(payment?.status).toBe('authorized');
    // No capture/earnings ledger entries were written.
    const postings = await h.repo.ledgerForRide(confirmed.ride.id);
    expect(postings.some((p) => p.kind === KINDS.capture)).toBe(false);
    expect(postings.some((p) => p.kind === KINDS.driverEarnings)).toBe(false);
    // Ride stays accepted (not completed).
    const ride = await h.repo.getRide(confirmed.ride.id);
    expect(ride?.status).toBe('accepted');
  });

  it('AC5+AC6: completion credits the FULL fare as take-home with a $0 commission line; take-home is derived and the group balances', async () => {
    const h = makeHarness();
    const driver = await registerDemoDriver(h);
    const { rideId, fareCents } = await runPaidRide(h, driver.id);

    const earnings = await h.earnings.tripEarnings(rideId);
    expect(earnings.takeHomeCents).toBe(fareCents);
    expect(earnings.platformCommissionCents).toBe(0);
    expect(earnings.balanced).toBe(true);
    // Explicit $0 platform_commission line item.
    const commissionLine = earnings.lines.find(
      (l) => l.kind === KINDS.platformCommission,
    );
    expect(commissionLine?.amountCents).toBe(0);

    // Derived from the ledger, and Σdebits === Σcredits for the ride.
    const postings = await h.repo.ledgerForRide(rideId);
    const net = postings.reduce(
      (acc, p) => acc + (p.direction === 'debit' ? p.amountCents : -p.amountCents),
      0,
    );
    expect(net).toBe(0);
  });

  it('AC-idempotent-complete: a retried completion does NOT double-post the ledger, so take-home stays exact', async () => {
    const h = makeHarness();
    const driver = await registerDemoDriver(h);
    const quote = await quoteDemo(h);
    const confirmed = await h.rides.confirm({
      quoteId: quote.id,
      riderPhone: DEMO_ROUTE.riderPhone,
    });
    await h.rides.accept(confirmed.ride.id, driver.id);
    const rideId = confirmed.ride.id;
    const fareCents = confirmed.ride.fareCents;

    // Two independent capture attempts — a double-tap / at-least-once retry —
    // each with its OWN entryGroupId, so an entry_group_id-based guard would
    // miss the duplicate. The UNIQUE(ride_id, kind, account) key is what makes
    // the second attempt a no-op.
    const attempt = () =>
      h.repo.persistCapture({
        rideId,
        ridePatch: { status: 'completed', completedAt: h.clock.now() },
        paymentPatch: { status: 'captured', updatedAt: h.clock.now() },
        postings: h.ledger.buildCapturePostings({
          rideId,
          driverId: driver.id,
          amountCents: fareCents,
          entryGroupId: randomUUID(),
        }),
      });
    await attempt();
    await attempt();

    const postings = await h.repo.ledgerForRide(rideId);
    // Exactly one earnings and one capture leg survived the retry.
    expect(postings.filter((p) => p.kind === KINDS.driverEarnings)).toHaveLength(
      1,
    );
    expect(postings.filter((p) => p.kind === KINDS.capture)).toHaveLength(1);
    // Derived take-home is the single fare, not double.
    expect(LedgerService.driverTakeHomeCents(postings, driver.id)).toBe(
      fareCents,
    );
  });

  it('AC-cancel: cancelling voids the authorization and posts reversing entries so the ledger nets to zero', async () => {
    const h = makeHarness();
    const quote = await quoteDemo(h);
    const confirmed = await h.rides.confirm({
      quoteId: quote.id,
      riderPhone: DEMO_ROUTE.riderPhone,
    });

    await h.rides.cancel(confirmed.ride.id);

    const payment = await h.repo.getPaymentByRide(confirmed.ride.id);
    expect(payment?.status).toBe('voided');
    const ride = await h.repo.getRide(confirmed.ride.id);
    expect(ride?.status).toBe('cancelled');

    const postings = await h.repo.ledgerForRide(confirmed.ride.id);
    expect(postings.length).toBeGreaterThan(0);
    const byAccount = new Map<string, number>();
    for (const p of postings) {
      const delta = p.direction === 'debit' ? p.amountCents : -p.amountCents;
      byAccount.set(p.account, (byAccount.get(p.account) ?? 0) + delta);
    }
    for (const net of byAccount.values()) {
      expect(net).toBe(0);
    }
    // No capture ever happened.
    expect(postings.some((p) => p.kind === KINDS.capture)).toBe(false);
  });

  it('AC7: a rider who completes a second ride within 7 days reports repeatedWithin7Days == true', async () => {
    const h = makeHarness();
    const driver = await registerDemoDriver(h);

    await runPaidRide(h, driver.id);
    // Less than a week later, the SAME rider books again.
    h.clock.advanceDays(1);
    await runPaidRide(h, driver.id);

    const rider = await h.rides.riderRepeatStatus(
      DEMO_ROUTE.riderPhone,
      DEMO_ROUTE.region,
    );
    expect(rider.ridesCount).toBe(2);
    expect(rider.repeatedWithin7Days).toBe(true);

    // Driver-side repeat supply holds too.
    const driverStatus = await h.rides.driverRepeatStatus(
      driver.id,
      DEMO_ROUTE.region,
    );
    expect(driverStatus.repeatedWithin7Days).toBe(true);
  });

  it('does NOT report repeat when the second ride is more than 7 days later', async () => {
    const h = makeHarness();
    const driver = await registerDemoDriver(h);
    await runPaidRide(h, driver.id);
    h.clock.advanceDays(8);
    await runPaidRide(h, driver.id);

    const rider = await h.rides.riderRepeatStatus(
      DEMO_ROUTE.riderPhone,
      DEMO_ROUTE.region,
    );
    expect(rider.ridesCount).toBe(2);
    expect(rider.repeatedWithin7Days).toBe(false);
  });

  it('driver session summary shows cumulative take-home and the "kept 100% vs Uber" delta', async () => {
    const h = makeHarness();
    const driver = await registerDemoDriver(h);
    const { fareCents } = await runPaidRide(h, driver.id);
    h.clock.advanceDays(1);
    const second = await runPaidRide(h, driver.id);

    const summary = await h.earnings.driverSummary(driver.id);
    expect(summary.trips).toBe(2);
    expect(summary.cumulativeTakeHomeCents).toBe(fareCents + second.fareCents);
    expect(summary.platformCommissionCents).toBe(0);
    // 25% reference commission on the cumulative take-home.
    expect(summary.uberWouldHaveTakenCents).toBe(
      Math.round((summary.cumulativeTakeHomeCents * 2500) / 10_000),
    );
    expect(summary.youKeptExtraCents).toBe(summary.uberWouldHaveTakenCents);
  });

  it('rejects a quote outside the single active geography', async () => {
    const h = makeHarness();
    await expect(
      h.quotes.createQuote({
        riderPhone: DEMO_ROUTE.riderPhone,
        region: 'geo-2',
        pickup: DEMO_ROUTE.pickup,
        dropoff: DEMO_ROUTE.dropoff,
      }),
    ).rejects.toThrow(/not served/);
  });
});
