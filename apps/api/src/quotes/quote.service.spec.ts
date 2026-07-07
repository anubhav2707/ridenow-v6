import { BadRequestException } from '@nestjs/common';
import { QuoteService, type CreateQuoteInput } from './quote.service';

// SCRUM-240 (locked, transparent upfront quote). Collaborators are faked. Tests
// cover the two guards visible in QuoteService.createQuote plus the happy path:
//  - a quote is issued for the single active region only (error path),
//  - the itemized components must sum EXACTLY to the locked total (the edge most
//    likely to break a "transparent" quote), and
//  - the success path: routing + pricing run, the view carries the locked total
//    and its components, expiresAt = clock.now() + the TTL, and the quote is
//    persisted via repo.insertQuote.
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
    const repo = { insertQuote: jest.fn().mockResolvedValue(undefined) };

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

  describe('happy path (core success behavior)', () => {
    it('sums pricing into a locked view, computes expiresAt from the TTL, and persists', async () => {
      const { service, routing, fares, clock, repo, env } = build();

      const view = await service.createQuote(validInput());

      // The success path exercises routing and pricing (unlike the guards, which
      // short-circuit earlier).
      expect(routing.route).toHaveBeenCalledTimes(1);
      expect(fares.price).toHaveBeenCalledTimes(1);

      // The view carries the locked total and its itemized components.
      expect(view.totalCents).toBe(1000);
      expect(view.components.map((c: any) => c.amountCents)).toEqual([300, 700]);

      // expiresAt is a real ISO instant at clock.now() + the configured TTL. This
      // assertion fails immediately if createQuote reads the wrong env TTL field
      // (e.g. quoteTtlSeconds instead of quoteTtlMs) or the wrong unit, which no
      // other test reaches.
      const expected = new Date(clock.now().getTime() + env.quoteTtlMs).toISOString();
      expect(view.expiresAt).toBe(expected);
      expect(Number.isNaN(Date.parse(view.expiresAt))).toBe(false);

      // The quote is persisted exactly once.
      expect(repo.insertQuote).toHaveBeenCalledTimes(1);
    });
  });
});
