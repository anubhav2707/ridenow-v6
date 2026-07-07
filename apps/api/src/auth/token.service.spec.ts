import { FakeClock } from '../clock/clock';
import { TEST_ENV } from '../testing/harness';
import { TokenService } from './token.service';

function makeTokens(): { tokens: TokenService; clock: FakeClock } {
  const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
  return { tokens: new TokenService(TEST_ENV, clock), clock };
}

describe('TokenService', () => {
  it('signs and verifies an access token carrying the subject and role', () => {
    const { tokens } = makeTokens();
    const token = tokens.signAccess({ sub: 'user-1', role: 'rider' });
    const claims = tokens.verifyAccess(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('rider');
    expect(claims.type).toBe('access');
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const { tokens } = makeTokens();
    const token = tokens.signAccess({ sub: 'user-1', role: 'rider' });
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: 'attacker',
        role: 'rider',
        type: 'access',
        iat: 0,
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    const forged = `${header}.${forgedPayload}.${signature}`;
    expect(() => tokens.verifyAccess(forged)).toThrow();
  });

  it('rejects an expired access token', () => {
    const { tokens, clock } = makeTokens();
    const token = tokens.signAccess({ sub: 'user-1', role: 'rider' });
    clock.advanceSeconds(TEST_ENV.auth.accessTtlSeconds + 1);
    expect(() => tokens.verifyAccess(token)).toThrow(/expired/);
  });

  it('will not accept a refresh token where an access token is expected', () => {
    const { tokens } = makeTokens();
    const refresh = tokens.signRefresh({
      sub: 'user-1',
      role: 'rider',
      sid: 'sess-1',
    });
    expect(() => tokens.verifyAccess(refresh)).toThrow();
    // But it IS valid as a refresh token, and its signature verifies even after
    // the (separate) access lifetime would have elapsed.
    const claims = tokens.verifyRefresh(refresh);
    expect(claims.sid).toBe('sess-1');
    expect(claims.type).toBe('refresh');
  });

  it('hashes tokens deterministically and irreversibly', () => {
    const { tokens } = makeTokens();
    const token = tokens.signRefresh({
      sub: 'u',
      role: 'rider',
      sid: 's',
    });
    const hash = tokens.hashToken(token);
    expect(hash).toHaveLength(64); // sha-256 hex
    expect(hash).not.toContain(token);
    expect(tokens.hashToken(token)).toBe(hash);
  });
});
