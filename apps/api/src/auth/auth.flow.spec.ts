import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { makeHarness, type Harness } from '../testing/harness';

const PHONE = '+15550100001';

// Capture the code the (otherwise console-only) SMS sender would deliver — this
// is how a test "reads the SMS" without the raw code ever crossing the API.
async function requestAndCaptureCode(
  h: Harness,
  phone = PHONE,
): Promise<{ code: string; channel: string }> {
  let code = '';
  const spy = jest
    .spyOn(h.sms, 'sendLoginCode')
    .mockImplementation(async (_phone, delivered) => {
      code = delivered;
      return 'console';
    });
  const result = await h.auth.requestOtp(phone);
  spy.mockRestore();
  expect(result).not.toHaveProperty('code');
  return { code, channel: result.channel };
}

async function expect4xx(
  fn: () => Promise<unknown>,
  messageRe?: RegExp,
): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(HttpException);
  const status = (err as HttpException).getStatus();
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
  if (messageRe) expect((err as Error).message).toMatch(messageRe);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('passwordless phone-OTP auth', () => {
  it('AC1: stores only a SHA-256 hash with a 5-minute TTL and never returns the raw code', async () => {
    const h = makeHarness();
    const { code, channel } = await requestAndCaptureCode(h);

    expect(channel).toBe('console'); // Twilio unset in tests
    expect(code).toMatch(/^\d{6}$/);

    const stored = await h.authRepo.getActiveOtp(PHONE);
    expect(stored).not.toBeNull();
    // The raw code is nowhere in storage — only its hash.
    expect(stored?.codeHash).toBe(sha256(code));
    expect(stored?.codeHash).not.toBe(code);
    const ttlMs =
      (stored as NonNullable<typeof stored>).expiresAt.getTime() -
      (stored as NonNullable<typeof stored>).createdAt.getTime();
    expect(ttlMs).toBe(h.env.auth.otpTtlSeconds * 1000);
    expect(ttlMs).toBe(5 * 60 * 1000);
  });

  it('AC2: a correct code creates the user and issues an access JWT (rider) + refresh token — no password', async () => {
    const h = makeHarness();
    const { code } = await requestAndCaptureCode(h);

    expect(await h.authRepo.getUserByPhone(PHONE)).toBeNull();
    const session = await h.auth.verifyOtp(PHONE, code);

    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(session.user.phone).toBe(PHONE);
    expect(session.user.role).toBe('rider');

    // The access token really carries the rider identity.
    const claims = h.tokens.verifyAccess(session.accessToken);
    expect(claims.sub).toBe(session.user.id);
    expect(claims.role).toBe('rider');

    // The account now exists and was created without any password field.
    const user = await h.authRepo.getUserByPhone(PHONE);
    expect(user?.id).toBe(session.user.id);
    expect(Object.keys(user ?? {})).not.toContain('password');
  });

  it('AC3: wrong / empty / expired / consumed codes are 4xx, issue no token, and lock out after max attempts', async () => {
    const h = makeHarness();
    const { code } = await requestAndCaptureCode(h);
    const wrong = code === '000000' ? '111111' : '000000';

    // Empty code.
    await expect4xx(() => h.auth.verifyOtp(PHONE, ''), /6-digit/);

    // Wrong code increments the attempt counter and issues nothing.
    await expect4xx(() => h.auth.verifyOtp(PHONE, wrong), /incorrect/);
    expect((await h.authRepo.getActiveOtp(PHONE))?.attempts).toBe(1);
    expect(await h.authRepo.getUserByPhone(PHONE)).toBeNull();

    // Exhaust the remaining attempts → locked out (even a correct code fails).
    for (let i = 1; i < h.env.auth.otpMaxAttempts; i++) {
      await expect4xx(() => h.auth.verifyOtp(PHONE, wrong));
    }
    expect((await h.authRepo.getActiveOtp(PHONE))?.attempts).toBe(
      h.env.auth.otpMaxAttempts,
    );
    await expect4xx(() => h.auth.verifyOtp(PHONE, code), /locked/);
    expect(await h.authRepo.getUserByPhone(PHONE)).toBeNull();
  });

  it('AC3: an expired code is rejected', async () => {
    const h = makeHarness();
    const { code } = await requestAndCaptureCode(h);
    h.clock.advanceSeconds(h.env.auth.otpTtlSeconds + 1);
    await expect4xx(() => h.auth.verifyOtp(PHONE, code), /expired/);
    expect(await h.authRepo.getUserByPhone(PHONE)).toBeNull();
  });

  it('AC3: a code is single-use — re-verifying the same code fails', async () => {
    const h = makeHarness();
    const { code } = await requestAndCaptureCode(h);
    await h.auth.verifyOtp(PHONE, code); // consumes it
    await expect4xx(() => h.auth.verifyOtp(PHONE, code), /no pending code/);
  });

  it('rate-limits OTP sends to one number within the window (anti-toll-fraud)', async () => {
    const h = makeHarness();
    for (let i = 0; i < h.env.auth.otpSendMax; i++) {
      await requestAndCaptureCode(h);
    }
    await expect4xx(() => h.auth.requestOtp(PHONE), /too many/);
  });

  it('AC4: refresh rotates the session — old token dies, role is preserved, verified even when access is expired', async () => {
    const h = makeHarness();
    const { code } = await requestAndCaptureCode(h);
    const session = await h.auth.verifyOtp(PHONE, code);

    // Access token has expired, but refresh still works off its own signature.
    h.clock.advanceSeconds(h.env.auth.accessTtlSeconds + 1);
    expect(() => h.tokens.verifyAccess(session.accessToken)).toThrow(/expired/);

    const rotated = await h.auth.refresh(session.refreshToken);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    // Role preserved on the new access token.
    expect(h.tokens.verifyAccess(rotated.accessToken).role).toBe('rider');

    // The old (rotated-away) refresh token is now dead.
    await expect4xx(() => h.auth.refresh(session.refreshToken), /not valid/);
    // The new one works and rotates again.
    const rotated2 = await h.auth.refresh(rotated.refreshToken);
    expect(rotated2.refreshToken).not.toBe(rotated.refreshToken);
  });

  it('AC4: a revoked (logged-out) refresh token yields 401 with no new session', async () => {
    const h = makeHarness();
    const { code } = await requestAndCaptureCode(h);
    const session = await h.auth.verifyOtp(PHONE, code);

    expect(await h.auth.logout(session.refreshToken)).toEqual({ revoked: true });
    await expect4xx(() => h.auth.refresh(session.refreshToken), /not valid/);
  });

  it('AC4: an expired refresh token yields 401', async () => {
    const h = makeHarness();
    const { code } = await requestAndCaptureCode(h);
    const session = await h.auth.verifyOtp(PHONE, code);

    h.clock.advanceSeconds(h.env.auth.refreshTtlSeconds + 1);
    await expect4xx(() => h.auth.refresh(session.refreshToken), /expired/);
  });
});
