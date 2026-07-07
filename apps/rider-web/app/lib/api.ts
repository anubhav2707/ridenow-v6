// Tiny typed client for the RideNow API. No SDK — just fetch — matching the
// backend's "raw primitives" style. The base URL comes from the build-time env.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: { id: string; phone: string; role: string };
}

export interface FareComponent {
  kind: string;
  label: string;
  amountCents: number;
  sortOrder: number;
}

export interface Quote {
  id: string;
  currency: string;
  totalCents: number;
  expiresAt: string;
  createdAt: string;
  surge: { applied: boolean; multiplier: number };
  locked: boolean;
  components: FareComponent[];
}

export interface Receipt {
  rideId: string;
  currency: string;
  amountChargedCents: number;
  captured: boolean;
  components: FareComponent[];
}

export interface ConfirmResult {
  ride: { id: string; status: string; fareCents: number };
  receipt: Receipt;
}

async function call<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body (gateway/proxy HTML, plain-text 5xx, etc.). Don't let the
    // SyntaxError mask the real outcome — surface the HTTP status instead.
    throw new Error(
      res.ok
        ? `unexpected non-JSON response (${res.status})`
        : `request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`,
    );
  }
  if (!res.ok) {
    const message =
      (data && (data.message as string | string[])) || `request failed (${res.status})`;
    throw new Error(Array.isArray(message) ? message.join(', ') : message);
  }
  return data as T;
}

export const api = {
  requestOtp: (phone: string): Promise<{ phone: string; channel: string }> =>
    call('/auth/otp/request', { method: 'POST', body: { phone } }),

  verifyOtp: (phone: string, code: string): Promise<AuthSession> =>
    call('/auth/otp/verify', { method: 'POST', body: { phone, code } }),

  savePaymentMethod: (
    token: string,
    stripePaymentMethodId: string,
    last4?: string,
  ): Promise<{ id: string; last4: string | null; isDefault: boolean }> =>
    call('/payment-methods', {
      method: 'POST',
      token,
      body: { stripePaymentMethodId, last4 },
    }),

  createQuote: (
    token: string,
    input: {
      riderPhone: string;
      region: string;
      pickup: { label: string; lat: number; lng: number };
      dropoff: { label: string; lat: number; lng: number };
    },
  ): Promise<Quote> => call('/quotes', { method: 'POST', token, body: input }),

  confirmRide: (
    token: string,
    quoteId: string,
    riderPhone: string,
  ): Promise<ConfirmResult> =>
    call('/rides', { method: 'POST', token, body: { quoteId, riderPhone } }),
};

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
