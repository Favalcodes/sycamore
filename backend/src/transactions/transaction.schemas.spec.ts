import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { backoffMs } from '../processing/classification.job.js';
import { isUnexpectedForDirection } from '../classification/categories.js';
import { transactionInputSchema } from './transaction.schemas.js';

const valid = {
  externalReference: 'REF-1',
  accountId: '0b9c4f8e-2a57-4f0e-9b3e-0d8e2c7a1f11',
  amount: '12999.75',
  direction: 'debit',
  description: 'SLACK TECHNOLOGIES',
  date: '2026-11-03',
};

describe('transactionInputSchema', () => {
  it('parses money straight to kobo and normalises enums', () => {
    const parsed = transactionInputSchema.parse(valid);
    expect(parsed.amount).toBe(1_299_975n);
    expect(parsed.direction).toBe('DEBIT');
    expect(parsed.currency).toBe('NGN');
  });

  it('reads a bare date as midnight in Lagos', () => {
    expect(transactionInputSchema.parse(valid).date.toISOString()).toBe(
      '2026-11-02T23:00:00.000Z',
    );
  });

  it('rejects a JSON number amount with an explanation', () => {
    const result = transactionInputSchema.safeParse({
      ...valid,
      amount: 12999.75,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/decimal string/);
  });

  it.each(['0', '0.00', '-1.00', '1.234'])('rejects amount %j', (amount) => {
    expect(transactionInputSchema.safeParse({ ...valid, amount }).success).toBe(
      false,
    );
  });

  it('rejects future dates, unknown currencies and bad directions', () => {
    expect(
      transactionInputSchema.safeParse({ ...valid, date: '2999-01-01' })
        .success,
    ).toBe(false);
    expect(
      transactionInputSchema.safeParse({ ...valid, currency: 'XYZ' }).success,
    ).toBe(false);
    expect(
      transactionInputSchema.safeParse({ ...valid, direction: 'sideways' })
        .success,
    ).toBe(false);
  });
});

describe('cursor', () => {
  it('round-trips and rejects tampering', () => {
    const c = {
      date: new Date('2026-11-03T10:00:00.000Z'),
      id: valid.accountId,
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(() => decodeCursor('not-a-cursor')).toThrow();
  });
});

describe('backoffMs', () => {
  it('grows exponentially and is capped', () => {
    const mid = () => 0.5; // no jitter
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(3, mid)).toBe(120_000);
    expect(backoffMs(20, mid)).toBe(30 * 60_000);
  });
});

describe('isUnexpectedForDirection', () => {
  it('flags credits labelled as expenses and debits labelled as revenue', () => {
    expect(isUnexpectedForDirection('SOFTWARE', 'CREDIT')).toBe(true);
    expect(isUnexpectedForDirection('REVENUE', 'DEBIT')).toBe(true);
    expect(isUnexpectedForDirection('REVENUE', 'CREDIT')).toBe(false);
    expect(isUnexpectedForDirection('TRANSFERS', 'CREDIT')).toBe(false);
  });
});
