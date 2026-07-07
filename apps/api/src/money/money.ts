// Integer minor-unit money. RideNow rule #1: money is ALWAYS an integer number
// of cents. No float/decimal arithmetic touches a monetary value anywhere in the
// codebase — the fare engine, ledger, and payment gateway all speak Cents.
export type Cents = number;

/** Throws unless `cents` is a non-negative integer. Used at every money boundary. */
export function assertNonNegativeInt(cents: Cents): void {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(
      `Invalid money amount: ${cents} — must be a non-negative integer number of cents`,
    );
  }
}

/** Throws unless `cents` is a strictly positive integer. */
export function assertPositiveInt(cents: Cents): void {
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error(
      `Invalid money amount: ${cents} — must be a positive integer number of cents`,
    );
  }
}

/** Adds two non-negative integer cent amounts, validating both operands. */
export function addCents(a: Cents, b: Cents): Cents {
  assertNonNegativeInt(a);
  assertNonNegativeInt(b);
  return a + b;
}

/** Sums a list of non-negative integer cent amounts. Empty list => 0. */
export function sumCents(list: readonly Cents[]): Cents {
  return list.reduce<Cents>((acc, c) => addCents(acc, c), 0);
}

/** Formats cents as USD for display only (e.g. 1234 => "$12.34"). Never used for math. */
export function formatUsd(cents: Cents): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`Cannot format non-integer cents: ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars}.${remainder.toString().padStart(2, '0')}`;
}
