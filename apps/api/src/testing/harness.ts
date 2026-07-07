import { FakeClock } from '../clock/clock';
import type { Env } from '../config/env';
import { DriverService } from '../drivers/driver.service';
import { EarningsService } from '../earnings/earnings.service';
import { FareService } from '../fares/fare.service';
import { GpsService } from '../gps/gps.service';
import { LedgerService } from '../ledger/ledger.service';
import { FakePaymentGateway } from '../payments/fake-payment-gateway';
import { InMemoryRideRepository } from '../persistence/in-memory.repository';
import { QuoteService } from '../quotes/quote.service';
import { RideService } from '../rides/ride.service';
import { HaversineRouting } from '../routing/routing';

export const TEST_ENV: Env = {
  activeRegion: 'geo-1',
  paymentsDriver: 'fake',
  store: 'memory',
  quoteTtlSeconds: 120,
  currency: 'usd',
  fare: {
    baseCents: 250,
    perKmCents: 120,
    perMinCents: 25,
    bookingFeeCents: 150,
  },
  uberReferenceCommissionBps: 2500,
};

export const DEMO_ROUTE = {
  riderPhone: '+15550100001',
  region: 'geo-1',
  pickup: { label: 'Downtown', lat: 37.7749, lng: -122.4194 },
  dropoff: { label: 'Airport', lat: 37.6213, lng: -122.379 },
};

/**
 * Wires the whole domain against in-memory infrastructure with a deterministic
 * clock and gateway. This is the same object graph CoreModule builds, minus Nest.
 */
export function makeHarness(opts: { gateway?: FakePaymentGateway } = {}) {
  const env = TEST_ENV;
  const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
  const routing = new HaversineRouting();
  const fares = new FareService(env);
  const ledger = new LedgerService();
  const repo = new InMemoryRideRepository();
  const earnings = new EarningsService(repo, env, ledger);
  const gateway = opts.gateway ?? new FakePaymentGateway();
  const quotes = new QuoteService(repo, clock, env, routing, fares);
  const rides = new RideService(repo, gateway, clock, env, ledger, earnings);
  const drivers = new DriverService(repo, clock, env);
  const gps = new GpsService(repo, clock);
  return {
    env,
    clock,
    routing,
    fares,
    ledger,
    repo,
    earnings,
    gateway,
    quotes,
    rides,
    drivers,
    gps,
  };
}

export type Harness = ReturnType<typeof makeHarness>;

/** Registers a demo driver in the active region. */
export async function registerDemoDriver(h: Harness, phone = '+15550109999') {
  return h.drivers.register({
    phone,
    displayName: 'Demo Driver',
    region: 'geo-1',
  });
}

/** Onboards a demo driver via the SCRUM-241 lightweight onboarding flow. */
export async function onboardDemoDriver(h: Harness, phone = '+15550108888') {
  return h.drivers.onboard({
    name: 'Demo Driver',
    phone,
    vehicleMake: 'Toyota',
    vehicleModel: 'Prius',
    vehiclePlate: 'RIDE-241',
    plan: 'flat_monthly',
  });
}

/** Quotes + confirms a ride, leaving it in 'offered' state, and returns the ride id + fare. */
export async function offerRide(
  h: Harness,
  riderPhone = DEMO_ROUTE.riderPhone,
): Promise<{ quoteId: string; rideId: string; fareCents: number }> {
  const quote = await h.quotes.createQuote({
    riderPhone,
    region: DEMO_ROUTE.region,
    pickup: DEMO_ROUTE.pickup,
    dropoff: DEMO_ROUTE.dropoff,
  });
  const confirmed = await h.rides.confirm({ quoteId: quote.id, riderPhone });
  return {
    quoteId: quote.id,
    rideId: confirmed.ride.id,
    fareCents: confirmed.ride.fareCents,
  };
}

/** Runs a full quote -> confirm -> accept -> complete ride and returns the ids. */
export async function runPaidRide(
  h: Harness,
  driverId: string,
  riderPhone = DEMO_ROUTE.riderPhone,
): Promise<{ quoteId: string; rideId: string; fareCents: number }> {
  const quote = await h.quotes.createQuote({
    riderPhone,
    region: DEMO_ROUTE.region,
    pickup: DEMO_ROUTE.pickup,
    dropoff: DEMO_ROUTE.dropoff,
  });
  const confirmed = await h.rides.confirm({ quoteId: quote.id, riderPhone });
  await h.rides.accept(confirmed.ride.id, driverId);
  const completed = await h.rides.complete(confirmed.ride.id);
  return {
    quoteId: quote.id,
    rideId: confirmed.ride.id,
    fareCents: completed.ride.fareCents,
  };
}