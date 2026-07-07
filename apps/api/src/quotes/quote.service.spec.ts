import { BadRequestException } from '@nestjs/common';
import { QuoteService, type CreateQuoteInput } from './quote.service';

// SCRUM-240 (locked, transparent upfront quote). Collaborators are faked; these
// tests assert only the two guards fully visible in QuoteService.createQuote:
//  - a quote is issued for the single active region only (error path), and
//  - the itemized components must sum EXACTLY to the locked total (the edge most
//    likely to break a "transparent" quote). Both guards run before persistence,
//    so the fakes never need the repository's real shape.
describe('QuoteService', () => {
  const validInput = (): CreateQuoteInput => ({
    riderPhone: '+15551234567',
    region: 'metropolis',
    pickup: { label: 'Home', lat: 40.0, lng: -73.0 },
    dropoff: { label: 'Office', lat: 40.1, lng: -73.1 },
  });

  function build(overrides: { activeRegion?: string; breakdown?: any } = {}) {
    const routing = {
      route: jest.fn().mockResolvedValue({ distanceMeters: 5200, durationSeconds: 900 }),
    };
    const fares = {
      price: jest.fn().mockReturnValue(
        overrides.breakdown ?? {
          currency: 'usd',
          totalCents: 1000,
          components: [
            { kind: 'base', label: 'Base fare', amountCents: 300, sortOrder: 0 },
            { kind: 'distance', label: 'Distance', amountCents: 700, sortOrder: 1 },
          ],
        },
      ),
    };
    const clock = { now: jest.fn().mockReturnValue(new Date('2026-07-07T12:00:00.000Z')) };
    const env = { activeRegion: overrides.activeRegion ?? 'metropolis', quoteTtlMs: 120_000 };
    const repo = { saveQuote: jest.fn().mockResolvedValue(undefined) };

    const service = new QuoteService(
      repo as any,
      clock as any,
      env as any,
      routing as any,
      fares as any,
    );
    return { service, routing, fares, clock, env, repo };
  }

  describe('region guard (error path)', () => {
    it('rejects a quote for a region other than the active region', async () => {
      const { service, routing } = build({ activeRegion: 'metropolis' });
      const input = { ...validInput(), region: 'atlantis' };

      await expect(service.createQuote(input)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.createQuote(input)).rejects.toThrow(/not served/i);
      // Guard must short-circuit before any routing/pricing work happens.
      expect(routing.route).not.toHaveBeenCalled();
    });
  });

  describe('locked-total invariant (edge most likely to break)', () => {
    it('refuses to issue a quote whose components do not sum to the total', async () => {
      const { service, routing } = build({
        activeRegion: 'metropolis',
        breakdown: {
          currency: 'usd',
          totalCents: 1599, // components below sum to 1000, not 1599
          components: [
            { kind: 'base', label: 'Base fare', amountCents: 500, sortOrder: 0 },
            { kind: 'distance', label: 'Distance', amountCents: 500, sortOrder: 1 },
          ],
        },
      });

      await expect(service.createQuote(validInput())).rejects.toThrow(/do not sum/i);
      // The invariant is checked after pricing, so routing did run.
      expect(routing.route).toHaveBeenCalledTimes(1);
    });
  });
});
