import type { Cents } from '../money/money';

// PaymentGateway port. All external money movement goes through this interface
// so CI runs a deterministic fake and prod swaps in Stripe via an env flag.
// The flow is a single manual-capture PaymentIntent:
//   authorize (confirm) -> capture (completion) | void (cancel).

export interface AuthorizeInput {
  rideId: string;
  amountCents: Cents;
  currency: string;
  idempotencyKey: string;
  /**
   * The rider's saved (tokenized) Stripe payment method, when one exists. Passing
   * it lets Stripe authorize off-session against the saved card with no card
   * re-entry. Undefined for the legacy flow (no saved card) — the fake gateway
   * ignores it and Stripe would require a card at confirmation time.
   */
  paymentMethodId?: string;
  /** The rider's Stripe customer id, paired with paymentMethodId. */
  customerId?: string;
}

export interface AuthorizeResult {
  intentId: string;
  gateway: string;
  status: 'authorized';
}

export interface CaptureInput {
  intentId: string;
  amountCents: Cents;
  idempotencyKey: string;
}

export interface CaptureResult {
  intentId: string;
  status: 'captured';
}

export interface VoidInput {
  intentId: string;
  idempotencyKey: string;
}

export interface VoidResult {
  intentId: string;
  status: 'voided';
}

export interface PaymentGateway {
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  voidAuthorization(input: VoidInput): Promise<VoidResult>;
}

/** Raised when the gateway itself fails (network, declined, etc.). */
export class PaymentGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

/** Nest DI token for the active PaymentGateway. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
