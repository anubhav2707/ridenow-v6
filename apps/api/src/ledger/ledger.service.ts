import { Injectable } from '@nestjs/common';
import { assertNonNegativeInt, assertPositiveInt, type Cents } from '../money/money';
import {
  ACCOUNTS,
  KINDS,
  type LedgerEntryRow,
  type LedgerPosting,
} from './ledger.types';

/**
 * Builds and validates the append-only double-entry postings that back every
 * money movement, and DERIVES driver take-home from those postings (take-home
 * is never a mutable column).
 *
 * Lifecycle of a ride's ledger:
 *   confirm   -> authorization group (memo hold, nets to zero)
 *   complete  -> capture group       (releases hold, moves cash, credits driver
 *                                      the FULL fare, records a $0 commission line)
 *   cancel    -> void group          (reverses the hold; whole ride nets to zero)
 *
 * Flat-fee/subscription model: the driver keeps 100% of the fare and the
 * platform's commission line is an explicit $0.
 */
@Injectable()
export class LedgerService {
  /** Hold group posted at authorization time. Nets to zero. */
  buildAuthorizationPostings(input: {
    rideId: string;
    amountCents: Cents;
    entryGroupId: string;
  }): LedgerPosting[] {
    assertPositiveInt(input.amountCents);
    const base = {
      rideId: input.rideId,
      driverId: null,
      entryGroupId: input.entryGroupId,
      kind: KINDS.authorization,
      memo: 'Authorized rider payment hold',
    };
    const postings: LedgerPosting[] = [
      {
        ...base,
        account: ACCOUNTS.riderReceivable,
        direction: 'debit',
        amountCents: input.amountCents,
      },
      {
        ...base,
        account: ACCOUNTS.authorizationHold,
        direction: 'credit',
        amountCents: input.amountCents,
      },
    ];
    this.assertBalanced(postings);
    return postings;
  }

  /**
   * Capture group posted when the ride completes. Releases the hold, moves the
   * captured cash, credits the driver the FULL fare, and records the explicit
   * $0 platform_commission line.
   */
  buildCapturePostings(input: {
    rideId: string;
    driverId: string;
    amountCents: Cents;
    entryGroupId: string;
  }): LedgerPosting[] {
    assertPositiveInt(input.amountCents);
    const base = {
      rideId: input.rideId,
      entryGroupId: input.entryGroupId,
    };
    const postings: LedgerPosting[] = [
      // Release the authorization hold.
      {
        ...base,
        driverId: null,
        account: ACCOUNTS.authorizationHold,
        direction: 'debit',
        amountCents: input.amountCents,
        kind: KINDS.holdRelease,
        memo: 'Release authorization hold on capture',
      },
      {
        ...base,
        driverId: null,
        account: ACCOUNTS.riderReceivable,
        direction: 'credit',
        amountCents: input.amountCents,
        kind: KINDS.holdRelease,
        memo: 'Release authorization hold on capture',
      },
      // Move the captured cash and owe it, in full, to the driver.
      {
        ...base,
        driverId: null,
        account: ACCOUNTS.cash,
        direction: 'debit',
        amountCents: input.amountCents,
        kind: KINDS.capture,
        memo: 'Captured rider payment',
      },
      {
        ...base,
        driverId: input.driverId,
        account: ACCOUNTS.driverEarnings(input.driverId),
        direction: 'credit',
        amountCents: input.amountCents,
        kind: KINDS.driverEarnings,
        memo: 'Driver take-home (100% of fare)',
      },
      // Explicit $0 platform commission line — the flat-fee model made visible.
      // A zero-amount credit keeps the group balanced while documenting the cut.
      {
        ...base,
        driverId: input.driverId,
        account: ACCOUNTS.platformCommission,
        direction: 'credit',
        amountCents: 0,
        kind: KINDS.platformCommission,
        memo: 'Platform commission — $0 (flat-fee subscription model)',
      },
    ];
    this.assertBalanced(postings);
    return postings;
  }

  /** Void group posted on cancellation. Reverses the hold so the ride nets to zero. */
  buildVoidPostings(input: {
    rideId: string;
    amountCents: Cents;
    entryGroupId: string;
  }): LedgerPosting[] {
    assertPositiveInt(input.amountCents);
    const base = {
      rideId: input.rideId,
      driverId: null,
      entryGroupId: input.entryGroupId,
      kind: KINDS.void,
      memo: 'Voided authorization — ride cancelled',
    };
    const postings: LedgerPosting[] = [
      {
        ...base,
        account: ACCOUNTS.authorizationHold,
        direction: 'debit',
        amountCents: input.amountCents,
      },
      {
        ...base,
        account: ACCOUNTS.riderReceivable,
        direction: 'credit',
        amountCents: input.amountCents,
      },
    ];
    this.assertBalanced(postings);
    return postings;
  }

  /** Throws unless every amount is a non-negative integer and Σdebits === Σcredits. */
  assertBalanced(postings: readonly LedgerPosting[]): void {
    let debits = 0;
    let credits = 0;
    for (const p of postings) {
      assertNonNegativeInt(p.amountCents);
      if (p.direction === 'debit') debits += p.amountCents;
      else credits += p.amountCents;
    }
    if (debits !== credits) {
      throw new Error(
        `Unbalanced ledger group: debits=${debits} credits=${credits}`,
      );
    }
  }

  /** True when Σdebits === Σcredits across the given postings. */
  isBalanced(postings: readonly LedgerPosting[]): boolean {
    let net = 0;
    for (const p of postings) {
      net += p.direction === 'debit' ? p.amountCents : -p.amountCents;
    }
    return net === 0;
  }

  /**
   * Driver take-home DERIVED from the ledger: net credit to the driver's
   * earnings account. This is the source of truth for earnings — there is no
   * separately stored take-home field to drift out of sync.
   */
  static driverTakeHomeCents(
    entries: ReadonlyArray<LedgerPosting | LedgerEntryRow>,
    driverId: string,
  ): Cents {
    const account = ACCOUNTS.driverEarnings(driverId);
    let net = 0;
    for (const e of entries) {
      if (e.account !== account) continue;
      net += e.direction === 'credit' ? e.amountCents : -e.amountCents;
    }
    return net;
  }
}
