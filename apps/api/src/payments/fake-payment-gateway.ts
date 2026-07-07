import {
  PaymentGatewayError,
  type AuthorizeInput,
  type AuthorizeResult,
  type CaptureInput,
  type CaptureResult,
  type PaymentGateway,
  type VoidInput,
  type VoidResult,
} from './payment-gateway';

interface FakeIntent {
  amountCents: number;
  currency: string;
  status: 'authorized' | 'captured' | 'voided';
  /** Echoes the saved payment method used to authorize, for test assertions. */
  paymentMethodId?: string;
}

export interface FakeGatewayOptions {
  /** Force authorize() to fail — used to prove nothing is persisted on failure. */
  failAuthorize?: boolean;
  /** Force capture() to fail — used to prove capture stays atomic. */
  failCapture?: boolean;
  /** Force voidAuthorization() to fail. */
  failVoid?: boolean;
}

/**
 * Deterministic in-memory gateway for CI and local dev. Intent ids are derived
 * from the rideId so tests can assert them without randomness. Failure can be
 * injected to exercise the atomicity guarantees.
 */
export class FakePaymentGateway implements PaymentGateway {
  private readonly intents = new Map<string, FakeIntent>();

  constructor(private readonly options: FakeGatewayOptions = {}) {}

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    if (this.options.failAuthorize) {
      throw new PaymentGatewayError('fake gateway: authorize failed');
    }
    const intentId = `fake_pi_${input.rideId}`;
    this.intents.set(intentId, {
      amountCents: input.amountCents,
      currency: input.currency,
      status: 'authorized',
      paymentMethodId: input.paymentMethodId,
    });
    return { intentId, gateway: 'fake', status: 'authorized' };
  }

  /** Test-only read of a recorded intent (amount, status, saved card used). */
  getIntent(intentId: string): Readonly<FakeIntent> | undefined {
    return this.intents.get(intentId);
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    if (this.options.failCapture) {
      throw new PaymentGatewayError('fake gateway: capture failed');
    }
    const intent = this.intents.get(input.intentId);
    if (!intent || intent.status !== 'authorized') {
      throw new PaymentGatewayError(
        `fake gateway: intent ${input.intentId} is not authorized`,
      );
    }
    if (intent.amountCents !== input.amountCents) {
      throw new PaymentGatewayError(
        `fake gateway: capture amount ${input.amountCents} != authorized ${intent.amountCents}`,
      );
    }
    intent.status = 'captured';
    return { intentId: input.intentId, status: 'captured' };
  }

  async voidAuthorization(input: VoidInput): Promise<VoidResult> {
    if (this.options.failVoid) {
      throw new PaymentGatewayError('fake gateway: void failed');
    }
    const intent = this.intents.get(input.intentId);
    if (intent && intent.status === 'authorized') {
      intent.status = 'voided';
    }
    return { intentId: input.intentId, status: 'voided' };
  }
}
