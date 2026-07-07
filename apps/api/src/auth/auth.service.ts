import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import { ENV, type Env } from '../config/env';
import {
  AUTH_REPOSITORY,
  type AuthRepository,
  type SessionRow,
  type UserRole,
  type UserRow,
} from './auth.repository';
import { SmsService, type SmsChannel } from './sms.service';
import { TokenService } from './token.service';

export interface OtpRequestResult {
  phone: string;
  /** How the code was delivered — 'console' in dev when Twilio is unset. */
  channel: SmsChannel;
  expiresAt: string;
  // The raw code is DELIBERATELY absent — it is never returned over the API.
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface AuthenticatedUser {
  id: string;
  phone: string;
  role: UserRole;
}

export interface AuthSession extends AuthTokens {
  user: AuthenticatedUser;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const SIX_DIGITS = /^\d{6}$/;

/**
 * Passwordless phone-OTP authentication. There is no password anywhere: proving
 * control of an SMS-delivered 6-digit code mints an access JWT (rider role) plus
 * a rotating refresh token. Anti-toll-fraud controls (send-rate limit, attempt
 * lockout, single-use codes, hashed storage) are implemented explicitly here
 * rather than delegated to Twilio Verify.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly tokens: TokenService,
    private readonly sms: SmsService,
  ) {}

  /**
   * Step 1 of signup/login: send a one-time code. Rate-limited per phone within a
   * sliding window; the code is stored ONLY as a SHA-256 hash with a short TTL and
   * is never included in the response.
   */
  async requestOtp(rawPhone: string): Promise<OtpRequestResult> {
    const phone = normalizePhone(rawPhone);
    const now = this.clock.now();

    const windowStart = new Date(
      now.getTime() - this.env.auth.otpSendWindowSeconds * 1000,
    );
    const sends = await this.repo.countOtpSends(phone, windowStart);
    if (sends >= this.env.auth.otpSendMax) {
      // Toll-fraud / SMS-pumping guard: too many codes to one number, too fast.
      throw new HttpException(
        'too many verification codes requested — try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateOtpCode();
    const expiresAt = new Date(now.getTime() + this.env.auth.otpTtlSeconds * 1000);
    await this.repo.insertOtp({
      id: randomUUID(),
      phone,
      codeHash: sha256(code),
      expiresAt,
      attempts: 0,
      consumedAt: null,
      createdAt: now,
    });

    const channel = await this.sms.sendLoginCode(phone, code);
    return { phone, channel, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Step 2: verify the code. On success the user is created if absent and an
   * access + refresh token pair is issued (rider role). Wrong/empty/expired/
   * already-consumed codes are rejected with a 4xx, increment the attempt counter,
   * and lock the code out after OTP_MAX_ATTEMPTS.
   */
  async verifyOtp(rawPhone: string, code: string): Promise<AuthSession> {
    const phone = normalizePhone(rawPhone);
    if (!code || !SIX_DIGITS.test(code)) {
      throw new BadRequestException('a 6-digit code is required');
    }
    const now = this.clock.now();

    const otp = await this.repo.getActiveOtp(phone);
    if (!otp) {
      throw new BadRequestException('no pending code for this number');
    }
    if (otp.attempts >= this.env.auth.otpMaxAttempts) {
      throw new BadRequestException(
        'too many incorrect attempts — this code is locked, request a new one',
      );
    }
    if (otp.expiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException('code has expired — request a new one');
    }
    if (!constantTimeEquals(sha256(code), otp.codeHash)) {
      // Persist the failed attempt so lockout survives across requests.
      await this.repo.updateOtp(otp.id, { attempts: otp.attempts + 1 });
      throw new BadRequestException('incorrect code');
    }

    // Correct: consume the code (single-use) and authenticate.
    await this.repo.updateOtp(otp.id, { consumedAt: now });
    const user =
      (await this.repo.getUserByPhone(phone)) ??
      (await this.repo.createUser({
        id: randomUUID(),
        phone,
        role: 'rider',
        createdAt: now,
      }));

    const tokens = await this.issueSession(user);
    return {
      ...tokens,
      user: { id: user.id, phone: user.phone, role: user.role },
    };
  }

  /**
   * Rotate a refresh token. The refresh JWT's signature is verified (independent
   * of any access-token expiry), the session is looked up by stored hash gated on
   * revokedAt IS NULL, and — in a single transaction — the old session is revoked
   * and a new one issued preserving the role. A revoked or expired refresh yields
   * 401 with no new session.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    if (!refreshToken) {
      throw new UnauthorizedException('refresh token is required');
    }
    // Signature + expiry + type check. Throws 401 on any failure.
    this.tokens.verifyRefresh(refreshToken);

    const hash = this.tokens.hashToken(refreshToken);
    const session = await this.repo.getActiveSessionByRefreshHash(hash);
    if (!session) {
      // Unknown, already-rotated, or explicitly revoked.
      throw new UnauthorizedException('refresh token is not valid');
    }
    const now = this.clock.now();
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedException('refresh token has expired');
    }
    const user = await this.repo.getUser(session.userId);
    if (!user) {
      throw new UnauthorizedException('refresh token is not valid');
    }

    const newSid = randomUUID();
    const newRefresh = this.tokens.signRefresh({
      sub: user.id,
      role: session.role,
      sid: newSid,
    });
    const newSession: SessionRow = {
      id: newSid,
      userId: user.id,
      refreshTokenHash: this.tokens.hashToken(newRefresh),
      role: session.role,
      expiresAt: new Date(
        now.getTime() + this.env.auth.refreshTtlSeconds * 1000,
      ),
      revokedAt: null,
      createdAt: now,
    };
    // Atomic: revoke the presented session and install the replacement together.
    await this.repo.rotateSession(session.id, newSession);

    const accessToken = this.tokens.signAccess({
      sub: user.id,
      role: session.role,
    });
    return {
      accessToken,
      refreshToken: newRefresh,
      accessExpiresAt: this.accessExpiry(now).toISOString(),
      refreshExpiresAt: newSession.expiresAt.toISOString(),
    };
  }

  /** Explicitly revoke a refresh session (logout). Idempotent. */
  async logout(refreshToken: string): Promise<{ revoked: boolean }> {
    if (!refreshToken) return { revoked: false };
    const hash = this.tokens.hashToken(refreshToken);
    const session = await this.repo.getActiveSessionByRefreshHash(hash);
    if (!session) return { revoked: false };
    await this.repo.revokeSession(session.id, this.clock.now());
    return { revoked: true };
  }

  private async issueSession(user: UserRow): Promise<AuthTokens> {
    const now = this.clock.now();
    const sid = randomUUID();
    const refreshToken = this.tokens.signRefresh({
      sub: user.id,
      role: user.role,
      sid,
    });
    const refreshExpiresAt = new Date(
      now.getTime() + this.env.auth.refreshTtlSeconds * 1000,
    );
    await this.repo.insertSession({
      id: sid,
      userId: user.id,
      refreshTokenHash: this.tokens.hashToken(refreshToken),
      role: user.role,
      expiresAt: refreshExpiresAt,
      revokedAt: null,
      createdAt: now,
    });
    const accessToken = this.tokens.signAccess({
      sub: user.id,
      role: user.role,
    });
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: this.accessExpiry(now).toISOString(),
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  private accessExpiry(now: Date): Date {
    return new Date(now.getTime() + this.env.auth.accessTtlSeconds * 1000);
  }
}

function normalizePhone(raw: string): string {
  const phone = (raw ?? '').trim();
  if (!E164.test(phone)) {
    throw new BadRequestException(
      'phone must be in E.164 format, e.g. +15551234567',
    );
  }
  return phone;
}

/** CSPRNG-backed, zero-padded 6-digit code. */
function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Constant-time compare of two equal-length hex digests (avoids leaking the code
// via timing). Lengths always match for SHA-256, but guard anyway.
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
