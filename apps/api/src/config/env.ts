// Startup configuration. There is no @nestjs/config in this repo, so this small
// module fills the gap: it reads process.env, applies SAFE NON-SECRET defaults,
// and validates real secrets at boot (rejecting empties AND known placeholders).
import type { Cents } from '../money/money';

export type PaymentsDriver = 'fake' | 'stripe';
export type StoreDriver = 'memory' | 'postgres';
/** Server-side money-safety gate: which Stripe universe we are allowed to touch. */
export type StripeMode = 'test' | 'live';

export interface FareConfig {
  baseCents: Cents;
  perKmCents: Cents;
  perMinCents: Cents;
  bookingFeeCents: Cents;
}

// Passwordless-auth + anti-toll-fraud knobs. All have safe non-secret defaults so
// the app boots in dev/CI; JWT_SECRET falls back to a clearly-marked dev value and
// is rejected only when running in production (see requireProdSecret).
export interface AuthConfig {
  jwtSecret: string;
  /** Short-lived bearer access token lifetime, in seconds (default 15m). */
  accessTtlSeconds: number;
  /** Rotating refresh token lifetime, in seconds (default 30d). */
  refreshTtlSeconds: number;
  /** How long a one-time SMS code stays valid, in seconds (default 5m). */
  otpTtlSeconds: number;
  /** Wrong-code attempts allowed before the pending code locks out. */
  otpMaxAttempts: number;
  /** Sliding window for send-rate limiting, in seconds (anti-toll-fraud). */
  otpSendWindowSeconds: number;
  /** Max OTP sends allowed to one phone number inside the window. */
  otpSendMax: number;
}

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
}

export interface Env {
  /** The single feature-flagged geography this MVP serves. */
  activeRegion: string;
  /** 'production' locks down secret fallbacks; anything else is dev/test. */
  appEnv: string;
  paymentsDriver: PaymentsDriver;
  store: StoreDriver;
  /** How long a locked quote stays confirmable, in seconds. */
  quoteTtlSeconds: number;
  currency: string;
  fare: FareConfig;
  /** Display-only reference: the % (in basis points) a legacy platform would skim. */
  uberReferenceCommissionBps: number;
  /** Server-side-only test/live gate for real money movement. */
  stripeMode: StripeMode;
  /** Only present/required when paymentsDriver === 'stripe'. */
  stripeSecretKey?: string;
  auth: AuthConfig;
  twilio: TwilioConfig;
}

// Values that must NEVER be accepted as a real secret. Keeping this list explicit
// is the whole point: the .env.example ships `sk_test_xxx`, so silently trusting it
// would let a misconfigured deploy think it can move real money.
const PLACEHOLDER_SECRETS = new Set([
  '',
  'changeme',
  'sk_test_xxx',
  'sk_live_xxx',
  'pk_test_xxx',
  'your-key-here',
]);

function readInt(
  source: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${key}: ${raw} — must be a non-negative integer`);
  }
  return value;
}

function readEnum<T extends string>(
  source: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = source[key]?.trim();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid ${key}: ${raw} — expected one of ${allowed.join(', ')}`,
    );
  }
  return raw as T;
}

// A dev-only JWT signing key. Fine for local/CI (deterministic, no secret to
// leak) but MUST be overridden in production — assertStripeMode-style boot checks
// and requireProdSecret below make the production requirement explicit.
const DEV_JWT_SECRET = 'dev-insecure-jwt-secret-change-me';

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const appEnv = source.APP_ENV?.trim() || 'development';
  const paymentsDriver = readEnum<PaymentsDriver>(
    source,
    'PAYMENTS_DRIVER',
    ['fake', 'stripe'],
    'fake',
  );
  const store = readEnum<StoreDriver>(
    source,
    'STORE',
    ['memory', 'postgres'],
    'memory',
  );

  const stripeMode = readEnum<StripeMode>(
    source,
    'STRIPE_MODE',
    ['test', 'live'],
    'test',
  );
  const stripeSecretKey = source.STRIPE_SECRET_KEY?.trim();
  if (paymentsDriver === 'stripe') {
    if (!stripeSecretKey || PLACEHOLDER_SECRETS.has(stripeSecretKey)) {
      throw new Error(
        'PAYMENTS_DRIVER=stripe requires a real STRIPE_SECRET_KEY. ' +
          'Refusing to start with an empty or placeholder value — real money ' +
          'movement is an escalation-before-launch item, not a default.',
      );
    }
  }

  // JWT secret: a fixed dev fallback keeps CI/local booting, but a real secret is
  // mandatory in production so tokens can't be forged with a public value.
  const rawJwtSecret = source.JWT_SECRET?.trim();
  const jwtSecret =
    rawJwtSecret && !PLACEHOLDER_SECRETS.has(rawJwtSecret)
      ? rawJwtSecret
      : requireProdSecret(appEnv, rawJwtSecret, 'JWT_SECRET', DEV_JWT_SECRET);

  return {
    activeRegion: source.ACTIVE_REGION?.trim() || 'geo-1',
    appEnv,
    paymentsDriver,
    store,
    // The locked upfront quote is honored for 10 minutes before confirmation
    // (SCRUM-240 AC): long enough for the rider to review, short enough that a
    // stale route/price can't be confirmed hours later.
    quoteTtlSeconds: readInt(source, 'QUOTE_TTL_SECONDS', 600),
    currency: source.CURRENCY?.trim() || 'usd',
    fare: {
      baseCents: readInt(source, 'FARE_BASE_CENTS', 250),
      perKmCents: readInt(source, 'FARE_PER_KM_CENTS', 120),
      perMinCents: readInt(source, 'FARE_PER_MIN_CENTS', 25),
      bookingFeeCents: readInt(source, 'FARE_BOOKING_FEE_CENTS', 150),
    },
    uberReferenceCommissionBps: readInt(
      source,
      'UBER_REFERENCE_COMMISSION_BPS',
      2500,
    ),
    stripeMode,
    stripeSecretKey,
    auth: {
      jwtSecret,
      accessTtlSeconds: readInt(source, 'JWT_ACCESS_TTL_SECONDS', 15 * 60),
      refreshTtlSeconds: readInt(
        source,
        'JWT_REFRESH_TTL_SECONDS',
        30 * 24 * 60 * 60,
      ),
      otpTtlSeconds: readInt(source, 'OTP_TTL_SECONDS', 300),
      otpMaxAttempts: readInt(source, 'OTP_MAX_ATTEMPTS', 5),
      otpSendWindowSeconds: readInt(source, 'OTP_SEND_WINDOW_SECONDS', 3600),
      otpSendMax: readInt(source, 'OTP_SEND_MAX', 5),
    },
    twilio: {
      accountSid: source.TWILIO_ACCOUNT_SID?.trim() || undefined,
      authToken: source.TWILIO_AUTH_TOKEN?.trim() || undefined,
      fromNumber: source.TWILIO_FROM_NUMBER?.trim() || undefined,
    },
  };
}

// In production a missing/placeholder secret is fatal; elsewhere we fall back to a
// clearly-marked dev value so the app still boots for local work and CI.
function requireProdSecret(
  appEnv: string,
  raw: string | undefined,
  name: string,
  devFallback: string,
): string {
  if (appEnv === 'production') {
    throw new Error(
      `${name} is required in production (got ${raw ? 'a placeholder' : 'nothing'}). ` +
        'Refusing to start with a forgeable signing key.',
    );
  }
  return devFallback;
}

/**
 * Boot-time money-safety gate: when Stripe is the live gateway, the secret key's
 * own livemode (sk_test_ vs sk_live_) MUST match the server-side STRIPE_MODE flag.
 * A test key in live mode (or vice-versa) is a misconfiguration that could move —
 * or fail to move — real money, so we refuse to start. No-op for the fake gateway.
 */
export function assertStripeMode(env: Env): void {
  if (env.paymentsDriver !== 'stripe') return;
  const key = env.stripeSecretKey ?? '';
  const keyIsLive = key.startsWith('sk_live_');
  const keyIsTest = key.startsWith('sk_test_');
  if (!keyIsLive && !keyIsTest) {
    throw new Error(
      `STRIPE_SECRET_KEY has an unrecognized prefix — expected sk_test_ or sk_live_.`,
    );
  }
  const expectLive = env.stripeMode === 'live';
  if (expectLive !== keyIsLive) {
    throw new Error(
      `Stripe key livemode (${keyIsLive ? 'live' : 'test'}) does not match ` +
        `STRIPE_MODE=${env.stripeMode}. Refusing to start to avoid moving money ` +
        `in the wrong Stripe universe.`,
    );
  }
}

/** Nest DI token for the resolved Env. */
export const ENV = Symbol('ENV');
