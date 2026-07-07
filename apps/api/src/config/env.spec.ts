import { assertStripeMode, loadEnv } from './env';

describe('loadEnv', () => {
  it('applies safe non-secret defaults', () => {
    const env = loadEnv({});
    expect(env.activeRegion).toBe('geo-1');
    expect(env.appEnv).toBe('development');
    expect(env.paymentsDriver).toBe('fake');
    expect(env.store).toBe('memory');
    // The locked upfront quote is honored for 10 minutes (SCRUM-240 AC).
    expect(env.quoteTtlSeconds).toBe(600);
    expect(env.fare.baseCents).toBe(250);
    expect(env.uberReferenceCommissionBps).toBe(2500);
    expect(env.stripeMode).toBe('test');
  });

  it('applies safe passwordless-auth defaults and a dev JWT fallback', () => {
    const env = loadEnv({});
    expect(env.auth.jwtSecret).toBeTruthy();
    expect(env.auth.accessTtlSeconds).toBe(15 * 60);
    expect(env.auth.refreshTtlSeconds).toBe(30 * 24 * 60 * 60);
    expect(env.auth.otpTtlSeconds).toBe(300);
    expect(env.auth.otpMaxAttempts).toBe(5);
    expect(env.auth.otpSendMax).toBe(5);
    // Twilio is optional — unset means OTPs are logged to the console.
    expect(env.twilio.accountSid).toBeUndefined();
  });

  it('requires a real JWT secret in production', () => {
    expect(() => loadEnv({ APP_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() =>
      loadEnv({ APP_ENV: 'production', JWT_SECRET: 's3cr3t-value' }).auth
        .jwtSecret,
    ).not.toThrow();
    expect(
      loadEnv({ APP_ENV: 'production', JWT_SECRET: 's3cr3t-value' }).auth
        .jwtSecret,
    ).toBe('s3cr3t-value');
  });

  it('gates Stripe test/live on the key prefix matching STRIPE_MODE', () => {
    // Fake gateway: never asserts.
    expect(() => assertStripeMode(loadEnv({}))).not.toThrow();
    // Test key in test mode: ok.
    expect(() =>
      assertStripeMode(
        loadEnv({
          PAYMENTS_DRIVER: 'stripe',
          STRIPE_SECRET_KEY: 'sk_test_realvalue123',
          STRIPE_MODE: 'test',
        }),
      ),
    ).not.toThrow();
    // Test key but STRIPE_MODE=live: refuse to start.
    expect(() =>
      assertStripeMode(
        loadEnv({
          PAYMENTS_DRIVER: 'stripe',
          STRIPE_SECRET_KEY: 'sk_test_realvalue123',
          STRIPE_MODE: 'live',
        }),
      ),
    ).toThrow(/does not match/);
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
