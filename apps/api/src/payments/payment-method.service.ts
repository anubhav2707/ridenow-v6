import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  AUTH_REPOSITORY,
  type AuthRepository,
  type PaymentMethodRow,
} from '../auth/auth.repository';
import { CLOCK, type Clock } from '../clock/clock';

export interface SavePaymentMethodInput {
  /** Opaque Stripe payment method id from Elements (e.g. pm_...). */
  stripePaymentMethodId: string;
  stripeCustomerId?: string;
  brand?: string;
  last4?: string;
}

/** Display-safe view — never exposes another user's token or the customer id. */
export interface PaymentMethodView {
  id: string;
  brand: string | null;
  last4: string | null;
  isDefault: boolean;
  createdAt: string;
}

/**
 * Saved (tokenized) rider cards. Card data itself is tokenized client-side via
 * Stripe Elements (SAQ-A); this service only ever handles the opaque token ids.
 * The most recently saved card becomes the rider's default, which is what the
 * next ride's authorization uses — enabling repeat rides with no card re-entry.
 */
@Injectable()
export class PaymentMethodService {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async save(
    userId: string,
    input: SavePaymentMethodInput,
  ): Promise<PaymentMethodView> {
    const token = input?.stripePaymentMethodId?.trim();
    if (!token) {
      throw new BadRequestException('stripePaymentMethodId is required');
    }
    const row: PaymentMethodRow = {
      id: randomUUID(),
      userId,
      stripeCustomerId: input.stripeCustomerId?.trim() || null,
      stripePaymentMethodId: token,
      brand: input.brand?.trim() || null,
      last4: input.last4?.trim() || null,
      // The latest saved card becomes the default the next ride authorizes on.
      isDefault: true,
      createdAt: this.clock.now(),
    };
    const saved = await this.repo.savePaymentMethod(row);
    return toView(saved);
  }

  async list(userId: string): Promise<PaymentMethodView[]> {
    const rows = await this.repo.listPaymentMethodsForUser(userId);
    return rows.map(toView);
  }
}

function toView(row: PaymentMethodRow): PaymentMethodView {
  return {
    id: row.id,
    brand: row.brand,
    last4: row.last4,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
  };
}
