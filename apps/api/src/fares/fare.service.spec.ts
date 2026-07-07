import type { Env } from '../config/env';
import { sumCents } from '../money/money';
import { FareService } from './fare.service';

const env: Env = {
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

describe('FareService', () => {
  const fares = new FareService(env);

  it('produces integer-cent components that sum EXACTLY to the total', () => {
    const breakdown = fares.price({
      distanceMeters: 5432,
      durationSeconds: 811,
    });
    for (const c of breakdown.components) {
      expect(Number.isInteger(c.amountCents)).toBe(true);
    }
    expect(sumCents(breakdown.components.map((c) => c.amountCents))).toBe(
      breakdown.totalCents,
    );
  });

  it('itemizes base, distance, time, and booking fee', () => {
    const breakdown = fares.price({ distanceMeters: 0, durationSeconds: 0 });
    const kinds = breakdown.components.map((c) => c.kind);
    expect(kinds).toEqual(['base', 'distance', 'time', 'booking_fee']);
    // Zero-length ride still has the fixed base + booking fee.
    expect(breakdown.totalCents).toBe(400);
  });
});
