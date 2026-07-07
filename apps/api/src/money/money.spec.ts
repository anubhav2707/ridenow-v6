import {
  addCents,
  assertNonNegativeInt,
  assertPositiveInt,
  formatUsd,
  sumCents,
} from './money';

describe('money', () => {
  it('rejects non-integer and negative amounts', () => {
    expect(() => assertNonNegativeInt(1.5)).toThrow();
    expect(() => assertNonNegativeInt(-1)).toThrow();
    expect(() => assertNonNegativeInt(0)).not.toThrow();
    expect(() => assertPositiveInt(0)).toThrow();
    expect(() => assertPositiveInt(1)).not.toThrow();
  });

  it('adds and sums integer cents exactly', () => {
    expect(addCents(250, 150)).toBe(400);
    expect(sumCents([250, 2160, 900, 150])).toBe(3460);
    expect(sumCents([])).toBe(0);
  });

  it('formats cents as USD for display only', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(3460)).toBe('$34.60');
    expect(formatUsd(5)).toBe('$0.05');
    expect(formatUsd(-865)).toBe('-$8.65');
  });
});
