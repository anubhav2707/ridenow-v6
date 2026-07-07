import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import { ENV, type Env } from '../config/env';
import type { UserRole } from './auth.repository';

export type TokenType = 'access' | 'refresh';

interface BaseClaims {
  sub: string;
  role: UserRole;
  type: TokenType;
  iat: number;
  exp: number;
}

export interface AccessClaims extends BaseClaims {
  type: 'access';
}

export interface RefreshClaims extends BaseClaims {
  type: 'refresh';
  /** Session id this refresh token belongs to (looked up by stored hash). */
  sid: string;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

/**
 * Minimal HS256 JWT + token hashing built on Node's crypto — no jsonwebtoken or
 * passport dependency, matching this codebase's "raw primitives, no SDK" style
 * (Stripe via fetch, money via integers). Access tokens are short-lived bearer
 * claims; refresh tokens carry a session id and are additionally validated
 * against a stored hash so they can be revoked/rotated server-side.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  signAccess(input: { sub: string; role: UserRole }): string {
    const now = this.nowSeconds();
    return this.encode({
      sub: input.sub,
      role: input.role,
      type: 'access',
      iat: now,
      exp: now + this.env.auth.accessTtlSeconds,
    });
  }

  signRefresh(input: { sub: string; role: UserRole; sid: string }): string {
    const now = this.nowSeconds();
    return this.encode({
      sub: input.sub,
      role: input.role,
      type: 'refresh',
      sid: input.sid,
      iat: now,
      exp: now + this.env.auth.refreshTtlSeconds,
    });
  }

  verifyAccess(token: string): AccessClaims {
    return this.verify(token, 'access') as AccessClaims;
  }

  verifyRefresh(token: string): RefreshClaims {
    return this.verify(token, 'refresh') as RefreshClaims;
  }

  /** SHA-256 hex of a token — the only form of a refresh token we persist. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private verify(token: string, expected: TokenType): BaseClaims {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('malformed token');
    }
    const [header, payload, signature] = parts;
    const expectedSig = this.sign(`${header}.${payload}`);
    const got = Buffer.from(signature);
    const want = Buffer.from(expectedSig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new UnauthorizedException('invalid token signature');
    }
    let claims: BaseClaims & { sid?: string };
    try {
      claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as BaseClaims;
    } catch {
      throw new UnauthorizedException('malformed token payload');
    }
    if (claims.type !== expected) {
      throw new UnauthorizedException(
        `expected a ${expected} token but got ${claims.type}`,
      );
    }
    // Expiry is checked here — the signature is valid regardless of any OTHER
    // (e.g. access) token's expiry, which is exactly what refresh relies on.
    if (typeof claims.exp !== 'number' || claims.exp <= this.nowSeconds()) {
      throw new UnauthorizedException('token expired');
    }
    return claims;
  }

  private encode(claims: BaseClaims & { sid?: string }): string {
    const header = base64urlJson(HEADER);
    const payload = base64urlJson(claims);
    const signature = this.sign(`${header}.${payload}`);
    return `${header}.${payload}.${signature}`;
  }

  private sign(data: string): string {
    return createHmac('sha256', this.env.auth.jwtSecret)
      .update(data)
      .digest('base64url');
  }

  private nowSeconds(): number {
    return Math.floor(this.clock.now().getTime() / 1000);
  }
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
