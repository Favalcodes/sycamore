/**
 * Money handling.
 *
 * Amounts are carried as integer minor units (kobo for NGN) in `bigint`
 * everywhere: API input strings are parsed straight into kobo with string
 * arithmetic, stored as Postgres BIGINT, summed by Postgres (SUM(bigint) ->
 * numeric, no overflow), and rendered back to a decimal string without ever
 * passing through a JavaScript `number`.
 *
 *   "12999.75"  --parse-->  1299975n  --store-->  BIGINT 1299975
 *   1299975n    --format->  "12999.75"
 */

/** Minor-unit exponent per supported currency. All supported currencies use 2. */
const MINOR_UNIT_DIGITS: Record<string, number> = {
  NGN: 2,
  USD: 2,
  GBP: 2,
  EUR: 2,
};
export const SUPPORTED_CURRENCIES = Object.keys(MINOR_UNIT_DIGITS);

/** Up to 15 whole digits (< 1 quadrillion) and at most 2 decimal places. */
export const DECIMAL_AMOUNT = /^(0|[1-9]\d{0,14})(\.\d{1,2})?$/;

export class InvalidAmountError extends Error {}

/** Parse a positive or zero decimal string like "12999.75" into minor units. */
export function parseAmountToMinor(input: string): bigint {
  const value = input.trim();
  if (!DECIMAL_AMOUNT.test(value)) {
    throw new InvalidAmountError(
      `"${input}" is not a valid amount; use a decimal string with at most 2 decimal places, e.g. "12999.75"`,
    );
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function isValidAmountString(input: string): boolean {
  return DECIMAL_AMOUNT.test(input.trim());
}

/** Render minor units as a plain decimal string: 1299975n -> "12999.75". */
export function formatMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Human-readable, for explanations: 1299975n -> "₦12,999.75". */
export function displayMoney(minor: bigint, currency = 'NGN'): string {
  const [whole, fraction] = formatMinor(minor < 0n ? -minor : minor).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return `${minor < 0n ? '-' : ''}${symbol}${grouped}.${fraction}`;
}

/** Serialisable money shape returned by the API. */
export interface MoneyDto {
  /** Integer minor units as a string (JSON numbers cannot hold every int64). */
  minor: string;
  /** Decimal string in major units, e.g. "12999.75". */
  value: string;
  currency: string;
}

export function toMoneyDto(minor: bigint, currency: string): MoneyDto {
  return { minor: minor.toString(), value: formatMinor(minor), currency };
}

/** Postgres returns SUM(bigint) as numeric, which pg hands back as a string. */
export function toBigInt(
  value: bigint | string | number | null | undefined,
): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new Error(`Unsafe integer for money: ${value}`);
    return BigInt(value);
  }
  return BigInt(value);
}
