// Startup configuration. There is no @nestjs/config in this repo, so this small
// module fills the gap: it reads process.env, applies SAFE NON-SECRET defaults,
// and validates real secrets at boot (rejecting empties AND known placeholders).
import type { Cents } from '../money/money';

export type PaymentsDriver = 'fake' | 'stripe';
export type StoreDriver = 'memory' | 'postgres';

export interface FareConfig {
  baseCents: Cents;
  perKmCents: Cents;
  perMinCents: Cents;
  bookingFeeCents: Cents;
}

export interface Env {
  /** The single feature-flagged geography this MVP serves. */
  activeRegion: string;
  paymentsDriver: PaymentsDriver;
  store: StoreDriver;
  /** How long a locked quote stays confirmable, in seconds. */
  quoteTtlSeconds: number;
  currency: string;
  fare: FareConfig;
  /** Display-only reference: the % (in basis points) a legacy platform would skim. */
  uberReferenceCommissionBps: number;
  /** Only present/required when paymentsDriver === 'stripe'. */
  stripeSecretKey?: string;
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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
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

  return {
    activeRegion: source.ACTIVE_REGION?.trim() || 'geo-1',
    paymentsDriver,
    store,
    quoteTtlSeconds: readInt(source, 'QUOTE_TTL_SECONDS', 120),
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
    stripeSecretKey,
  };
}

/** Nest DI token for the resolved Env. */
export const ENV = Symbol('ENV');
