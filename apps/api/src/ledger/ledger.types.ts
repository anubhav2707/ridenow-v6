import type { Cents } from '../money/money';

export type LedgerDirection = 'debit' | 'credit';

/**
 * A single side of a double-entry posting. Postings are grouped by
 * `entryGroupId`; every group is internally balanced (Σdebits === Σcredits).
 * The ledger is append-only — nothing here is ever mutated after it is written.
 */
export interface LedgerPosting {
  account: string;
  direction: LedgerDirection;
  amountCents: Cents;
  kind: string;
  memo: string;
  // Platform-account legs (cash, hold, rider receivable) are driverless, but
  // every posting is ride-scoped — mirrors ledger_entries.ride_id NOT NULL.
  driverId: string | null;
  rideId: string;
  entryGroupId: string;
}

/** A persisted posting (adds the surrogate id + write timestamp). */
export interface LedgerEntryRow extends LedgerPosting {
  id: string;
  createdAt: Date;
}

// Account names + posting kinds are stable strings so ledger queries and
// derivations (e.g. driver take-home) can key off them.
export const ACCOUNTS = {
  cash: 'cash',
  riderReceivable: 'rider_receivable',
  authorizationHold: 'authorization_hold',
  driverEarnings: (driverId: string): string => `driver_earnings:${driverId}`,
  platformCommission: 'platform_commission',
} as const;

export const KINDS = {
  authorization: 'authorization',
  holdRelease: 'hold_release',
  capture: 'capture',
  driverEarnings: 'driver_earnings',
  platformCommission: 'platform_commission',
  void: 'void',
} as const;
