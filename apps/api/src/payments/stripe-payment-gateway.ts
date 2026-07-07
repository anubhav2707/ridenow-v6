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

// Real-money adapter, selected only when PAYMENTS_DRIVER=stripe. It talks to the
// Stripe PaymentIntents API over HTTPS (no SDK dependency) using manual capture:
//   authorize -> create PaymentIntent (capture_method=manual, confirm=true)
//   capture   -> POST /payment_intents/:id/capture
//   void      -> POST /payment_intents/:id/cancel
//
// NOTE: real charges, Connect payouts, and subscription billing are an
// escalation-before-real-money item. This adapter is wired but NOT exercised by
// CI; the deterministic FakePaymentGateway is the default everywhere else.
export class StripePaymentGateway implements PaymentGateway {
  private readonly base = 'https://api.stripe.com/v1';

  constructor(private readonly secretKey: string) {
    if (!secretKey) {
      throw new PaymentGatewayError('StripePaymentGateway requires a secret key');
    }
  }

  private async post(
    path: string,
    form: Record<string, string>,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const error = body.error as { message?: string } | undefined;
      throw new PaymentGatewayError(
        `stripe ${path} failed (${res.status}): ${error?.message ?? 'unknown error'}`,
      );
    }
    return body;
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const form: Record<string, string> = {
      amount: String(input.amountCents),
      currency: input.currency,
      capture_method: 'manual',
      confirm: 'true',
      'payment_method_types[]': 'card',
      'metadata[rideId]': input.rideId,
    };
    // When the rider has a saved (tokenized) card, authorize off-session against
    // it so no card details are re-entered at confirmation (SCRUM-240 AC).
    if (input.paymentMethodId) {
      form.payment_method = input.paymentMethodId;
      form.off_session = 'true';
      if (input.customerId) form.customer = input.customerId;
    }
    const body = await this.post('/payment_intents', form, input.idempotencyKey);
    const intentId = body.id as string;
    return { intentId, gateway: 'stripe', status: 'authorized' };
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    await this.post(
      `/payment_intents/${input.intentId}/capture`,
      { amount_to_capture: String(input.amountCents) },
      input.idempotencyKey,
    );
    return { intentId: input.intentId, status: 'captured' };
  }

  async voidAuthorization(input: VoidInput): Promise<VoidResult> {
    await this.post(
      `/payment_intents/${input.intentId}/cancel`,
      {},
      input.idempotencyKey,
    );
    return { intentId: input.intentId, status: 'voided' };
  }
}
