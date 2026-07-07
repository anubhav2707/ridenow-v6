'use client';

import { useState } from 'react';
import {
  api,
  formatMoney,
  type AuthSession,
  type ConfirmResult,
  type Quote,
} from './lib/api';

type Step = 'phone' | 'otp' | 'card' | 'ride' | 'done';

// A single feature-flagged geography (everything else is out of MVP scope).
const REGION = 'geo-1';
const DEFAULT_PICKUP = { label: 'Downtown', lat: 37.7749, lng: -122.4194 };
const DEFAULT_DROPOFF = { label: 'Airport', lat: 37.6213, lng: -122.379 };

export default function Home() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('+15551234567');
  const [code, setCode] = useState('');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [cardSaved, setCardSaved] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const requestOtp = () =>
    run(async () => {
      const res = await api.requestOtp(phone.trim());
      setNotice(
        res.channel === 'console'
          ? 'Code sent (dev mode: check the API server console for the 6-digit code).'
          : 'Code sent via SMS.',
      );
      setStep('otp');
    });

  const verifyOtp = () =>
    run(async () => {
      const s = await api.verifyOtp(phone.trim(), code.trim());
      setSession(s);
      setNotice(null);
      setStep('card');
    });

  const saveCard = () =>
    run(async () => {
      if (!session) throw new Error('not signed in');
      // In production the card is tokenized client-side by Stripe Elements; here
      // we save a Stripe test payment method token to keep the flow keyless.
      await api.savePaymentMethod(session.accessToken, 'pm_card_visa', '4242');
      setCardSaved(true);
      setStep('ride');
    });

  const getQuote = () =>
    run(async () => {
      if (!session) throw new Error('not signed in');
      const q = await api.createQuote(session.accessToken, {
        riderPhone: session.user.phone,
        region: REGION,
        pickup: DEFAULT_PICKUP,
        dropoff: DEFAULT_DROPOFF,
      });
      setQuote(q);
    });

  const confirmRide = () =>
    run(async () => {
      if (!session || !quote) throw new Error('missing session or quote');
      const result = await api.confirmRide(
        session.accessToken,
        quote.id,
        session.user.phone,
      );
      setConfirmation(result);
      setStep('done');
    });

  return (
    <main style={styles.main}>
      <h1>RideNow — Rider</h1>
      <p style={styles.tagline}>
        Locked, transparent upfront fares. No surge. Pay with a saved card.
      </p>

      <Steps current={step} />

      {notice && <p style={styles.notice}>{notice}</p>}
      {error && <p style={styles.error}>{error}</p>}

      {step === 'phone' && (
        <section style={styles.card}>
          <h2>Sign in with your phone</h2>
          <p style={styles.muted}>No password — we text you a one-time code.</p>
          <input
            style={styles.input}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+15551234567"
            aria-label="Phone number"
          />
          <button style={styles.button} onClick={requestOtp} disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </section>
      )}

      {step === 'otp' && (
        <section style={styles.card}>
          <h2>Enter the 6-digit code</h2>
          <input
            style={styles.input}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            inputMode="numeric"
            maxLength={6}
            aria-label="Verification code"
          />
          <button style={styles.button} onClick={verifyOtp} disabled={busy}>
            {busy ? 'Verifying…' : 'Verify & continue'}
          </button>
        </section>
      )}

      {step === 'card' && (
        <section style={styles.card}>
          <h2>Add a payment method</h2>
          <p style={styles.muted}>
            Saved once, reused for every ride — no re-entry. (Test card 4242.)
          </p>
          <button style={styles.button} onClick={saveCard} disabled={busy}>
            {busy ? 'Saving…' : 'Save test card •••• 4242'}
          </button>
        </section>
      )}

      {step === 'ride' && (
        <section style={styles.card}>
          <h2>Your trip</h2>
          <p style={styles.muted}>
            {DEFAULT_PICKUP.label} → {DEFAULT_DROPOFF.label}
            {cardSaved ? ' · card saved' : ''}
          </p>
          {!quote ? (
            <button style={styles.button} onClick={getQuote} disabled={busy}>
              {busy ? 'Pricing…' : 'Get upfront fare'}
            </button>
          ) : (
            <>
              <QuoteBreakdown quote={quote} />
              <button style={styles.button} onClick={confirmRide} disabled={busy}>
                {busy ? 'Confirming…' : `Confirm ride — ${formatMoney(quote.totalCents, quote.currency)}`}
              </button>
            </>
          )}
        </section>
      )}

      {step === 'done' && confirmation && (
        <section style={styles.card}>
          <h2>Ride confirmed ✓</h2>
          <p style={styles.muted}>
            Charged exactly the locked quote — no more, no less.
          </p>
          <Receipt result={confirmation} />
        </section>
      )}
    </main>
  );
}

function QuoteBreakdown({ quote }: { quote: Quote }) {
  return (
    <div style={styles.breakdown}>
      <div style={styles.lockRow}>
        <span>🔒 Locked fare</span>
        <span>{quote.surge.applied ? 'Surge' : 'No surge'}</span>
      </div>
      {quote.components
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => (
          <div key={c.kind} style={styles.row}>
            <span>{c.label}</span>
            <span>{formatMoney(c.amountCents, quote.currency)}</span>
          </div>
        ))}
      <div style={styles.totalRow}>
        <span>Total</span>
        <span>{formatMoney(quote.totalCents, quote.currency)}</span>
      </div>
      <p style={styles.fineprint}>
        This total will not change after you confirm, regardless of traffic or
        time. Held for 10 minutes.
      </p>
    </div>
  );
}

function Receipt({ result }: { result: ConfirmResult }) {
  const { receipt } = result;
  return (
    <div style={styles.breakdown}>
      {receipt.components
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => (
          <div key={c.kind} style={styles.row}>
            <span>{c.label}</span>
            <span>{formatMoney(c.amountCents, receipt.currency)}</span>
          </div>
        ))}
      <div style={styles.totalRow}>
        <span>Charged</span>
        <span>{formatMoney(receipt.amountChargedCents, receipt.currency)}</span>
      </div>
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const order: Step[] = ['phone', 'otp', 'card', 'ride', 'done'];
  const labels: Record<Step, string> = {
    phone: 'Phone',
    otp: 'Verify',
    card: 'Card',
    ride: 'Fare',
    done: 'Paid',
  };
  const idx = order.indexOf(current);
  return (
    <ol style={styles.steps}>
      {order.map((s, i) => (
        <li
          key={s}
          style={{
            ...styles.step,
            fontWeight: i === idx ? 700 : 400,
            opacity: i <= idx ? 1 : 0.4,
          }}
        >
          {labels[s]}
        </li>
      ))}
    </ol>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 460,
    margin: '0 auto',
    padding: '2rem 1.25rem',
  },
  tagline: { color: '#444', marginTop: '-0.5rem' },
  steps: {
    display: 'flex',
    gap: '0.5rem',
    listStyle: 'none',
    padding: 0,
    fontSize: 13,
  },
  step: { flex: 1, textAlign: 'center' },
  card: {
    border: '1px solid #e2e2e2',
    borderRadius: 12,
    padding: '1.25rem',
    marginTop: '1rem',
  },
  input: {
    width: '100%',
    padding: '0.6rem',
    fontSize: 16,
    border: '1px solid #ccc',
    borderRadius: 8,
    margin: '0.5rem 0',
    boxSizing: 'border-box',
  },
  button: {
    width: '100%',
    padding: '0.7rem',
    fontSize: 16,
    background: '#111',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  muted: { color: '#666', fontSize: 14 },
  notice: {
    background: '#eef6ff',
    border: '1px solid #cfe4ff',
    padding: '0.6rem',
    borderRadius: 8,
    fontSize: 14,
  },
  error: {
    background: '#fdecec',
    border: '1px solid #f5c2c2',
    color: '#a12',
    padding: '0.6rem',
    borderRadius: 8,
    fontSize: 14,
  },
  breakdown: { margin: '0.75rem 0' },
  lockRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontWeight: 600,
    marginBottom: '0.5rem',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.25rem 0',
    color: '#333',
  },
  totalRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '0.5rem 0',
    borderTop: '1px solid #e2e2e2',
    marginTop: '0.5rem',
    fontWeight: 700,
  },
  fineprint: { color: '#888', fontSize: 12, marginTop: '0.5rem' },
};
