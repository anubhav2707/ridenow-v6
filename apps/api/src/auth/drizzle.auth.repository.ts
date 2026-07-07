import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';
import { otpCodes, paymentMethods, sessions, users } from '../db/schema';
import {
  type AuthRepository,
  type OtpCodeRow,
  type PaymentMethodRow,
  type SessionRow,
  type UserRole,
  type UserRow,
} from './auth.repository';

type Db = typeof defaultDb;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/**
 * Postgres-backed AuthRepository (selected when STORE=postgres). rotateSession
 * runs the revoke + insert inside db.transaction so a refresh can never leave two
 * live sessions or none.
 */
export class DrizzleAuthRepository implements AuthRepository {
  constructor(private readonly db: Db = defaultDb) {}

  async getUserByPhone(phone: string): Promise<UserRow | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.phone, phone));
    return row ? mapUser(row) : null;
  }

  async getUser(id: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ? mapUser(row) : null;
  }

  async createUser(user: UserRow): Promise<UserRow> {
    // A concurrent signup for the same phone conflicts on the unique index; fall
    // back to the existing row so verify is idempotent per phone.
    const [row] = await this.db
      .insert(users)
      .values(user)
      .onConflictDoNothing({ target: users.phone })
      .returning();
    if (row) return mapUser(row);
    const existing = await this.getUserByPhone(user.phone);
    if (!existing) throw new Error(`failed to create or find user ${user.phone}`);
    return existing;
  }

  async insertOtp(otp: OtpCodeRow): Promise<void> {
    await this.db.insert(otpCodes).values(otp);
  }

  async getActiveOtp(phone: string): Promise<OtpCodeRow | null> {
    const [row] = await this.db
      .select()
      .from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt)))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);
    return row ? mapOtp(row) : null;
  }

  async updateOtp(id: string, patch: Partial<OtpCodeRow>): Promise<OtpCodeRow> {
    const [row] = await this.db
      .update(otpCodes)
      .set(patch)
      .where(eq(otpCodes.id, id))
      .returning();
    return mapOtp(row);
  }

  async countOtpSends(phone: string, since: Date): Promise<number> {
    const rows = await this.db
      .select({ id: otpCodes.id })
      .from(otpCodes)
      .where(and(eq(otpCodes.phone, phone), gte(otpCodes.createdAt, since)));
    return rows.length;
  }

  async insertSession(session: SessionRow): Promise<void> {
    await this.db.insert(sessions).values(session);
  }

  async getActiveSessionByRefreshHash(
    hash: string,
  ): Promise<SessionRow | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.refreshTokenHash, hash),
          isNull(sessions.revokedAt),
        ),
      );
    return row ? mapSession(row) : null;
  }

  async rotateSession(
    oldSessionId: string,
    newSession: SessionRow,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: newSession.createdAt })
        .where(eq(sessions.id, oldSessionId));
      await tx.insert(sessions).values(newSession);
    });
  }

  async revokeSession(id: string, now: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(eq(sessions.id, id));
  }

  async savePaymentMethod(pm: PaymentMethodRow): Promise<PaymentMethodRow> {
    return this.db.transaction(async (tx) => {
      if (pm.isDefault) {
        await tx
          .update(paymentMethods)
          .set({ isDefault: false })
          .where(eq(paymentMethods.userId, pm.userId));
      }
      const [row] = await tx
        .insert(paymentMethods)
        .values(pm)
        .onConflictDoNothing({
          target: [
            paymentMethods.userId,
            paymentMethods.stripePaymentMethodId,
          ],
        })
        .returning();
      if (row) return mapPaymentMethod(row);
      const [existing] = await tx
        .select()
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.userId, pm.userId),
            eq(
              paymentMethods.stripePaymentMethodId,
              pm.stripePaymentMethodId,
            ),
          ),
        );
      return mapPaymentMethod(existing);
    });
  }

  async getDefaultPaymentMethodForUser(
    userId: string,
  ): Promise<PaymentMethodRow | null> {
    const rows = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.userId, userId));
    const mapped = rows.map(mapPaymentMethod);
    const preferred =
      mapped.find((p) => p.isDefault) ??
      mapped.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    return preferred ?? null;
  }

  async getDefaultPaymentMethodForPhone(
    phone: string,
  ): Promise<PaymentMethodRow | null> {
    const user = await this.getUserByPhone(phone);
    if (!user) return null;
    return this.getDefaultPaymentMethodForUser(user.id);
  }

  async listPaymentMethodsForUser(
    userId: string,
  ): Promise<PaymentMethodRow[]> {
    const rows = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.userId, userId));
    return rows
      .map(mapPaymentMethod)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

function mapUser(row: Row): UserRow {
  return { ...(row as UserRow), role: row.role as UserRole };
}

function mapOtp(row: Row): OtpCodeRow {
  return row as OtpCodeRow;
}

function mapSession(row: Row): SessionRow {
  return { ...(row as SessionRow), role: row.role as UserRole };
}

function mapPaymentMethod(row: Row): PaymentMethodRow {
  return row as PaymentMethodRow;
}
