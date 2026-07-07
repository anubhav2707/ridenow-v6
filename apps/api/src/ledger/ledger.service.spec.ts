import { LedgerService } from './ledger.service';
import { KINDS } from './ledger.types';

describe('LedgerService', () => {
  const ledger = new LedgerService();
  const rideId = 'ride-1';
  const driverId = 'driver-1';
  const groupId = 'group-1';
  const fare = 3460;

  it('builds a balanced authorization hold that nets to zero', () => {
    const postings = ledger.buildAuthorizationPostings({
      rideId,
      amountCents: fare,
      entryGroupId: groupId,
    });
    expect(ledger.isBalanced(postings)).toBe(true);
    // Nobody is credited earnings yet.
    expect(LedgerService.driverTakeHomeCents(postings, driverId)).toBe(0);
  });

  it('captures the full fare as driver take-home with an explicit $0 commission', () => {
    const postings = ledger.buildCapturePostings({
      rideId,
      driverId,
      amountCents: fare,
      entryGroupId: groupId,
    });
    expect(ledger.isBalanced(postings)).toBe(true);
    expect(LedgerService.driverTakeHomeCents(postings, driverId)).toBe(fare);

    const commission = postings.filter(
      (p) => p.kind === KINDS.platformCommission,
    );
    expect(commission).toHaveLength(1);
    expect(commission[0].amountCents).toBe(0);
  });

  it('cancels to net-zero when authorization + void are combined', () => {
    const auth = ledger.buildAuthorizationPostings({
      rideId,
      amountCents: fare,
      entryGroupId: 'g-auth',
    });
    const voided = ledger.buildVoidPostings({
      rideId,
      amountCents: fare,
      entryGroupId: 'g-void',
    });
    const all = [...auth, ...voided];
    expect(ledger.isBalanced(all)).toBe(true);
    // Every account nets to zero across the two groups.
    const byAccount = new Map<string, number>();
    for (const p of all) {
      const delta = p.direction === 'debit' ? p.amountCents : -p.amountCents;
      byAccount.set(p.account, (byAccount.get(p.account) ?? 0) + delta);
    }
    for (const net of byAccount.values()) {
      expect(net).toBe(0);
    }
  });

  it('rejects an unbalanced group', () => {
    expect(() =>
      ledger.assertBalanced([
        {
          account: 'cash',
          direction: 'debit',
          amountCents: 100,
          kind: 'x',
          memo: '',
          driverId: null,
          rideId: 'ride-x',
          entryGroupId: 'g',
        },
      ]),
    ).toThrow(/Unbalanced/);
  });
});
