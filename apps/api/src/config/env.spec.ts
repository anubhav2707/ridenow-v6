import { loadEnv } from './env';

describe('loadEnv', () => {
  it('applies safe non-secret defaults', () => {
    const env = loadEnv({});
    expect(env.activeRegion).toBe('geo-1');
    expect(env.paymentsDriver).toBe('fake');
    expect(env.store).toBe('memory');
    expect(env.quoteTtlSeconds).toBe(120);
    expect(env.fare.baseCents).toBe(250);
    expect(env.uberReferenceCommissionBps).toBe(2500);
  });

  it('rejects placeholder Stripe keys when the stripe driver is selected', () => {
    expect(() =>
      loadEnv({ PAYMENTS_DRIVER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_xxx' }),
    ).toThrow(/real STRIPE_SECRET_KEY/);
    expect(() =>
      loadEnv({ PAYMENTS_DRIVER: 'stripe', STRIPE_SECRET_KEY: '' }),
    ).toThrow();
    expect(() => loadEnv({ PAYMENTS_DRIVER: 'stripe' })).toThrow();
  });

  it('accepts a real-looking Stripe key', () => {
    const env = loadEnv({
      PAYMENTS_DRIVER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_realvalue123',
    });
    expect(env.paymentsDriver).toBe('stripe');
    expect(env.stripeSecretKey).toBe('sk_test_realvalue123');
  });

  it('rejects invalid integer and enum values', () => {
    expect(() => loadEnv({ QUOTE_TTL_SECONDS: 'abc' })).toThrow();
    expect(() => loadEnv({ STORE: 'mysql' })).toThrow();
    expect(() => loadEnv({ PAYMENTS_DRIVER: 'paypal' })).toThrow();
  });
});
