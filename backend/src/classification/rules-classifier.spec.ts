import type { Direction } from '../generated/prisma/enums.js';
import { RulesClassifier } from './rules-classifier.js';

const rules = new RulesClassifier();
const classify = (description: string, direction: Direction = 'DEBIT') =>
  rules.classify({
    id: 'x',
    description,
    merchant: null,
    direction,
    amount: '1000.00',
    currency: 'NGN',
  });

describe('RulesClassifier', () => {
  it.each([
    ['NIP TRANSFER FEE', 'BANK_FEES'],
    ['VAT ON NIP CHARGE', 'BANK_FEES'],
    ['SMS ALERT CHARGES', 'BANK_FEES'],
    ['STAMP DUTY CHARGE', 'BANK_FEES'],
    ['LIRS PAYE REMITTANCE OCT 2026', 'TAX'],
    ['FCT-IRS PAYE REMITTANCE', 'TAX'],
    ['FIRS VAT REMITTANCE', 'TAX'],
    ['SALARY PAYMENT NOV 2026 - STAFF PAYROLL', 'PAYROLL'],
    ['PENSION REMITTANCE - STANBIC IBTC PFA', 'PAYROLL'],
    ['GOOGLE *GSUITE OFADAKITCHEN', 'SOFTWARE'],
    ['AWS EMEA AWS.AMAZON.CO', 'SOFTWARE'],
    ['IKEJA ELECTRIC PREPAID TOKEN', 'UTILITIES'],
    ['DIESEL SUPPLY FOR GENERATOR', 'UTILITIES'],
    ['WAREHOUSE LEASE PAYMENT - OREGUN', 'RENT'],
    ['META PLATFORMS ADS FACEBK *ADS', 'MARKETING'],
    ['AIR PEACE ABV-LOS TICKET', 'TRAVEL'],
    ['SWEEP TO OPERATIONS ACCOUNT', 'TRANSFERS'],
    ['FUNDING OF PAYROLL ACCOUNT - ACCESS', 'TRANSFERS'],
  ])('debit %j -> %s', (description, category) => {
    expect(classify(description)?.category).toBe(category);
  });

  it.each([
    ['PAYSTACK SETTLEMENT 2026-11-12', 'REVENUE'],
    ['NIP TRF FROM BUKKA HUT/INV-20431', 'REVENUE'],
    ['INTER-ACCOUNT SWEEP FROM MONIEPOINT', 'TRANSFERS'],
  ])('credit %j -> %s', (description, category) => {
    expect(classify(description, 'CREDIT')?.category).toBe(category);
  });

  it('does not treat a bank charge mentioning VAT as a tax payment', () => {
    expect(classify('VAT ON NIP CHARGE')?.category).toBe('BANK_FEES');
  });

  it('does not let "diesel" in a truck purchase look like a utility bill', () => {
    expect(
      classify('TRF TO HALLMARK MOTORS - 2 UNITS MAN DIESEL TRUCKS'),
    ).toBeNull();
  });

  it('respects direction: expense rules never fire on money coming in', () => {
    expect(classify('AWS EMEA REFUND', 'CREDIT')).toBeNull();
    expect(classify('SALARY REVERSAL RETURNED', 'CREDIT')).toBeNull();
  });

  it('gives a generic inbound transfer only a weak guess, so the AI decides', () => {
    const match = classify('TRF FROM CHIDI NWOSU', 'CREDIT');
    expect(match?.category).toBe('REVENUE');
    expect(match!.confidence).toBeLessThan(0.9);
  });

  it('explains which rule matched', () => {
    expect(classify('SMS ALERT CHARGES')?.rationale).toContain('bank-fees');
  });

  it('returns null when nothing matches', () => {
    expect(classify('TRF TO K. OKONKWO')).toBeNull();
  });
});
