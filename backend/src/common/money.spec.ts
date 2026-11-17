import {
  displayMoney,
  formatMinor,
  InvalidAmountError,
  parseAmountToMinor,
  toBigInt,
  toMoneyDto,
} from './money.js';

describe('money', () => {
  it('stores ₦12,999.75 as exactly 1,299,975 kobo and renders it back unchanged', () => {
    const minor = parseAmountToMinor('12999.75');
    expect(minor).toBe(1_299_975n);
    expect(formatMinor(minor)).toBe('12999.75');
    expect(displayMoney(minor)).toBe('₦12,999.75');
  });

  it('sums without floating-point drift (0.1 + 0.2 is exactly 0.30)', () => {
    // In IEEE-754 doubles, 0.1 + 0.2 === 0.30000000000000004.
    expect(0.1 + 0.2).not.toBe(0.3);
    const total = parseAmountToMinor('0.10') + parseAmountToMinor('0.20');
    expect(formatMinor(total)).toBe('0.30');
  });

  it('adds a million ₦0.01 entries exactly', () => {
    let total = 0n;
    for (let i = 0; i < 1_000_000; i++) total += parseAmountToMinor('0.01');
    expect(formatMinor(total)).toBe('10000.00');
  });

  it.each([
    ['5', 500n],
    ['5.5', 550n],
    ['0.01', 1n],
    ['999999999999999.99', 99_999_999_999_999_999n],
  ])('parses %s', (input, expected) => {
    expect(parseAmountToMinor(input)).toBe(expected);
  });

  it.each([
    '',
    '12.345',
    '-5',
    '1e3',
    '12,999.75',
    '.50',
    '00.5',
    'abc',
    '1000000000000000',
  ])('rejects %j', (input) => {
    expect(() => parseAmountToMinor(input)).toThrow(InvalidAmountError);
  });

  it('handles values beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const big = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    expect(formatMinor(big)).toBe('90071992547409.93');
    expect(toMoneyDto(big, 'NGN')).toEqual({
      minor: '9007199254740993',
      value: '90071992547409.93',
      currency: 'NGN',
    });
  });

  it('formats negative values (e.g. net cash flow)', () => {
    expect(formatMinor(-1_299_975n)).toBe('-12999.75');
    expect(displayMoney(-50n)).toBe('-₦0.50');
  });

  it('converts Postgres numeric strings to bigint and refuses unsafe numbers', () => {
    expect(toBigInt('40161637225')).toBe(40_161_637_225n);
    expect(toBigInt(null)).toBe(0n);
    expect(() => toBigInt(2 ** 60)).toThrow();
  });
});
