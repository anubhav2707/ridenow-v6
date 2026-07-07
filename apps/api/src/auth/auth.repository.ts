// Persisted row shapes for the passwordless-auth + saved-payment surface. Like
// the ride repository, these are plain interfaces so the domain never imports the
// ORM; the in-memory and Drizzle implementations both satisfy AuthRepository.

export type UserRole = 'rider' | 'driver';

export interface UserRow {
  id: string;
  phone: string;
  role: UserRole;
  createdAt: Date;
}

export interface OtpCodeRow {
  id: string;
  phone: string;
  /** SHA-256 hex of the 6-digit code. The raw code is NEVER persisted. */
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface SessionRow {
  id: string;
  userId: string;
  /** SHA-256 hex of the rotating refresh token. */
  refreshTokenHash: string;
  role: UserRole;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface PaymentMethodRow {
  id: string;
  userId: string;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string;
  brand: string | null;
  last4: string | null;
  isDefault: boolean;
  createdAt: Date;
}

/**
 * Persistence port for rider identity, one-time codes, refresh sessions, and
 * saved payment methods. The two multi-row mutations (rotateSession) run in a
 * single transaction in the Drizzle implementation so a refresh can never leave
 * two live sessions or zero.
 */
export interface AuthRepository {
  // --- users ---
  getUserByPhone(phone: string): Promise<UserRow | null>;
  getUser(id: string): Promise<UserRow | null>;
  createUser(user: UserRow): Promise<UserRow>;

  // --- otp codes ---
  insertOtp(otp: OtpCodeRow): Promise<void>;
  /** Latest not-yet-consumed code for a phone (may be expired — caller checks). */
  getActiveOtp(phone: string): Promise<OtpCodeRow | null>;
  updateOtp(id: string, patch: Partial<OtpCodeRow>): Promise<OtpCodeRow>;
  /** How many codes were sent to this phone at/after `since` (send-rate limit). */
  countOtpSends(phone: string, since: Date): Promise<number>;

  // --- sessions ---
  insertSession(session: SessionRow): Promise<void>;
  /** Look up a live session by refresh-token hash, gated on revokedAt IS NULL. */
  getActiveSessionByRefreshHash(hash: string): Promise<SessionRow | null>;
  /** Revoke `oldSessionId` and insert `newSession` atomically (token rotation). */
  rotateSession(oldSessionId: string, newSession: SessionRow): Promise<void>;
  revokeSession(id: string, now: Date): Promise<void>;

  // --- payment methods ---
  savePaymentMethod(pm: PaymentMethodRow): Promise<PaymentMethodRow>;
  getDefaultPaymentMethodForUser(
    userId: string,
  ): Promise<PaymentMethodRow | null>;
  getDefaultPaymentMethodForPhone(
    phone: string,
  ): Promise<PaymentMethodRow | null>;
  listPaymentMethodsForUser(userId: string): Promise<PaymentMethodRow[]>;
}

/** Nest DI token for the active AuthRepository. */
export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');
