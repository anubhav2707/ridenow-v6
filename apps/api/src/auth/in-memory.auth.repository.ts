import type {
  AuthRepository,
  OtpCodeRow,
  PaymentMethodRow,
  SessionRow,
  UserRow,
} from './auth.repository';

/**
 * In-memory implementation of the {@link AuthRepository} port.
 *
 * This is the DEFAULT binding CoreModule wires whenever `store !== 'postgres'`
 * and it is also the repository every makeHarness-based spec depends on, so it
 * must provide the full port surface without any external infrastructure. It
 * mirrors InMemoryRideRepository: plain Maps keyed by id, deterministic reads,
 * and no clock of its own — callers build fully-timestamped rows and hand them
 * in, exactly as the Drizzle sibling persists them.
 */
export class InMemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, UserRow>();
  private readonly otpCodes = new Map<string, OtpCodeRow>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly paymentMethods = new Map<string, PaymentMethodRow>();

  // --- users ---------------------------------------------------------------
  async getUserByPhone(phone: string): Promise<UserRow | null> {
    for (const user of this.users.values()) {
      if (user.phone === phone) return user;
    }
    return null;
  }

  async getUser(id: string): Promise<UserRow | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(user: UserRow): Promise<UserRow> {
    this.users.set(user.id, user);
    return user;
  }

  // --- otp codes -------------------------------------------------------------
  async insertOtp(otp: OtpCodeRow): Promise<void> {
    this.otpCodes.set(otp.id, otp);
  }

  async getActiveOtp(phone: string): Promise<OtpCodeRow | null> {
    let latest: OtpCodeRow | null = null;
    for (const code of this.otpCodes.values()) {
      if (code.phone !== phone || code.consumedAt) continue;
      if (!latest || code.createdAt > latest.createdAt) latest = code;
    }
    return latest;
  }

  async updateOtp(id: string, patch: Partial<OtpCodeRow>): Promise<OtpCodeRow> {
    const current = this.otpCodes.get(id);
    if (!current) throw new Error(`otp code ${id} not found`);
    const updated = { ...current, ...patch, id: current.id };
    this.otpCodes.set(id, updated);
    return updated;
  }

  /** Send-rate window backing OTP_SEND_WINDOW/OTP_SEND_MAX enforcement. */
  async countOtpSends(phone: string, since: Date): Promise<number> {
    let count = 0;
    for (const code of this.otpCodes.values()) {
      if (code.phone === phone && code.createdAt >= since) count++;
    }
    return count;
  }

  /**
   * Identity-level lockout signal: failed attempts summed across ALL of the
   * phone's codes in the window — a fresh code cannot reset the lockout.
   */
  async countRecentFailedOtpAttempts(
    phone: string,
    since: Date,
  ): Promise<number> {
    let total = 0;
    for (const code of this.otpCodes.values()) {
      if (code.phone === phone && code.createdAt >= since) {
        total += code.attempts;
      }
    }
    return total;
  }

  // --- sessions --------------------------------------------------------------
  async insertSession(session: SessionRow): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getActiveSessionByRefreshHash(
    hash: string,
  ): Promise<SessionRow | null> {
    for (const session of this.sessions.values()) {
      if (session.refreshTokenHash === hash && !session.revokedAt) {
        return session;
      }
    }
    return null;
  }

  async rotateSession(
    oldSessionId: string,
    newSession: SessionRow,
  ): Promise<void> {
    const old = this.sessions.get(oldSessionId);
    if (old) {
      this.sessions.set(oldSessionId, {
        ...old,
        revokedAt: newSession.createdAt,
      });
    }
    this.sessions.set(newSession.id, newSession);
  }

  async revokeSession(id: string, now: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, revokedAt: now });
  }

  // --- payment methods ---------------------------------------------------------
  async savePaymentMethod(pm: PaymentMethodRow): Promise<PaymentMethodRow> {
    if (pm.isDefault) {
      for (const [id, other] of this.paymentMethods) {
        if (other.userId === pm.userId && other.isDefault) {
          this.paymentMethods.set(id, { ...other, isDefault: false });
        }
      }
    }
    this.paymentMethods.set(pm.id, pm);
    return pm;
  }

  async getDefaultPaymentMethodForUser(
    userId: string,
  ): Promise<PaymentMethodRow | null> {
    for (const pm of this.paymentMethods.values()) {
      if (pm.userId === userId && pm.isDefault) return pm;
    }
    return null;
  }

  async getDefaultPaymentMethodForPhone(
    phone: string,
  ): Promise<PaymentMethodRow | null> {
    const user = await this.getUserByPhone(phone);
    if (!user) return null;
    return this.getDefaultPaymentMethodForUser(user.id);
  }

  async listPaymentMethodsForUser(userId: string): Promise<PaymentMethodRow[]> {
    const rows: PaymentMethodRow[] = [];
    for (const pm of this.paymentMethods.values()) {
      if (pm.userId === userId) rows.push(pm);
    }
    return rows;
  }
}
