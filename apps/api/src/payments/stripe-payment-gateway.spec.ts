import {
  PaymentGatewayError,
  type AuthorizeInput,
  type CaptureInput,
  type VoidInput,
} from './payment-gateway';
import { StripePaymentGateway } from './stripe-payment-gateway';

// SCRUM-240 (Stripe test/live payment): the adapter is wired but never hit by
// CI, so these tests fake `fetch` and pin the exact PaymentIntents wire format
// (manual capture, off-session for saved cards, idempotency keys, error shape).
const SECRET = 'sk_test_123';

function jsonResponse(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Decode the urlencoded body the gateway POSTed to Stripe. */
function sentForm(call: any[]): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call[1].body)));
}

describe('StripePaymentGateway', () => {
  let fetchMock: jest.Mock;
  let gateway: StripePaymentGateway;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    gateway = new StripePaymentGateway(SECRET);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    it('rejects an empty secret key before any network call', () => {
      expect(() => new StripePaymentGateway('')).toThrow(PaymentGatewayError);
    });
  });

  describe('authorize (happy path — no saved card)', () => {
    it('creates a manual-capture PaymentIntent and returns the intent id', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(true, 200, { id: 'pi_live_1', status: 'requires_capture' }),
      );
      const input: AuthorizeInput = {
        amountCents: 1599,
        currency: 'usd',
        rideId: 'ride_1',
        idempotencyKey: 'idem-authorize-1',
      };

      const result = await gateway.authorize(input);

      expect(result).toEqual({
        intentId: 'pi_live_1',
        gateway: 'stripe',
        status: 'authorized',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(init.headers['Idempotency-Key']).toBe('idem-authorize-1');

      const form = sentForm(fetchMock.mock.calls[0]);
      expect(form).toMatchObject({
        amount: '1599',
        currency: 'usd',
        capture_method: 'manual',
        confirm: 'true',
        'payment_method_types[]': 'card',
        'metadata[rideId]': 'ride_1',
      });
      // No saved card => off-session fields must be absent.
      expect(form).not.toHaveProperty('payment_method');
      expect(form).not.toHaveProperty('off_session');
      expect(form).not.toHaveProperty('customer');
    });
  });

  describe('authorize (edge — saved tokenized card, off-session)', () => {
    it('charges the saved payment method off-session with its customer', async () => {
      fetchMock.mockResolvedValue(jsonResponse(true, 200, { id: 'pi_saved_1' }));
      const input: AuthorizeInput = {
        amountCents: 2500,
        currency: 'usd',
        rideId: 'ride_2',
        idempotencyKey: 'idem-authorize-2',
        paymentMethodId: 'pm_saved_1',
        customerId: 'cus_1',
      };

      await gateway.authorize(input);

      const form = sentForm(fetchMock.mock.calls[0]);
      expect(form).toMatchObject({
        payment_method: 'pm_saved_1',
        off_session: 'true',
        customer: 'cus_1',
      });
    });

    it('omits the customer when the saved card has no customer id', async () => {
      fetchMock.mockResolvedValue(jsonResponse(true, 200, { id: 'pi_saved_2' }));
      const input: AuthorizeInput = {
        amountCents: 2500,
        currency: 'usd',
        rideId: 'ride_3',
        idempotencyKey: 'idem-authorize-3',
        paymentMethodId: 'pm_saved_2',
      };

      await gateway.authorize(input);

      const form = sentForm(fetchMock.mock.calls[0]);
      expect(form.payment_method).toBe('pm_saved_2');
      expect(form.off_session).toBe('true');
      expect(form).not.toHaveProperty('customer');
    });
  });

  describe('authorize (error path)', () => {
    it('throws PaymentGatewayError carrying Stripe status and message', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(false, 402, { error: { message: 'Your card was declined.' } }),
      );
      const input: AuthorizeInput = {
        amountCents: 1599,
        currency: 'usd',
        rideId: 'ride_4',
        idempotencyKey: 'idem-authorize-4',
      };

      await expect(gateway.authorize(input)).rejects.toThrow(PaymentGatewayError);
      await expect(gateway.authorize(input)).rejects.toThrow(
        'stripe /payment_intents failed (402): Your card was declined.',
      );
    });

    it('falls back to "unknown error" when Stripe omits an error message', async () => {
      fetchMock.mockResolvedValue(jsonResponse(false, 500, {}));
      const input: AuthorizeInput = {
        amountCents: 1599,
        currency: 'usd',
        rideId: 'ride_5',
        idempotencyKey: 'idem-authorize-5',
      };

      await expect(gateway.authorize(input)).rejects.toThrow(
        'stripe /payment_intents failed (500): unknown error',
      );
    });
  });

  describe('capture', () => {
    it('captures the authorized intent for the given amount', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(true, 200, { id: 'pi_live_1', status: 'succeeded' }),
      );
      const input: CaptureInput = {
        intentId: 'pi_live_1',
        amountCents: 1599,
        idempotencyKey: 'idem-capture-1',
      };

      const result = await gateway.capture(input);

      expect(result).toEqual({ intentId: 'pi_live_1', status: 'captured' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_live_1/capture');
      expect(init.headers['Idempotency-Key']).toBe('idem-capture-1');
      expect(sentForm(fetchMock.mock.calls[0])).toEqual({ amount_to_capture: '1599' });
    });
  });

  describe('voidAuthorization', () => {
    it('cancels the intent and reports it voided', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(true, 200, { id: 'pi_live_1', status: 'canceled' }),
      );
      const input: VoidInput = {
        intentId: 'pi_live_1',
        idempotencyKey: 'idem-void-1',
      };

      const result = await gateway.voidAuthorization(input);

      expect(result).toEqual({ intentId: 'pi_live_1', status: 'voided' });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_live_1/cancel');
      expect(sentForm(fetchMock.mock.calls[0])).toEqual({});
    });
  });
});
