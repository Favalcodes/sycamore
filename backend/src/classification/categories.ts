import { Category, Direction } from '../generated/prisma/enums.js';

export const CATEGORIES = Object.values(Category) as Category[];

export const CATEGORY_LABELS: Record<Category, string> = {
  REVENUE: 'Revenue',
  PAYROLL: 'Payroll',
  SOFTWARE: 'Software',
  MARKETING: 'Marketing',
  TRAVEL: 'Travel',
  UTILITIES: 'Utilities',
  RENT: 'Rent',
  TAX: 'Tax',
  TRANSFERS: 'Transfers',
  BANK_FEES: 'Banking Fees',
  OTHER: 'Other',
};

/** Short definitions given to the language model, so its labels match ours. */
export const CATEGORY_DEFINITIONS: Record<Category, string> = {
  REVENUE:
    'Money received from customers for goods or services: sales, invoice payments, payment-gateway settlements (Paystack, Flutterwave), POS settlements.',
  PAYROLL:
    'Staff salaries, wages, bonuses, pension (PFA) and NHF contributions.',
  SOFTWARE:
    'SaaS subscriptions, cloud hosting, software licences (AWS, Google Workspace, Microsoft 365, Slack, Zoho...).',
  MARKETING:
    'Advertising, promotions, social media ads, sponsorships, branding, printing for campaigns.',
  TRAVEL:
    'Flights, hotels, ride-hailing (Uber, Bolt), per diems and other business travel.',
  UTILITIES:
    'Electricity (Ikeja Electric, EKEDC...), diesel for generators, water, waste (LAWMA), internet and telecoms (MTN, Airtel, Spectranet).',
  RENT: 'Office, warehouse or shop rent, lease payments and service charges.',
  TAX: 'Payments to tax authorities: FIRS, state IRS (LIRS), VAT, PAYE, withholding tax, company income tax.',
  TRANSFERS:
    "Movements between the business's own accounts, sweeps, or funding transfers that are not income or expense.",
  BANK_FEES:
    'Bank charges: transfer/NIP fees, SMS alerts, stamp duty, account maintenance, card fees, VAT on bank charges.',
  OTHER: 'Anything that does not clearly fit another category.',
};

const EXPENSE_CATEGORIES = new Set<Category>([
  'PAYROLL',
  'SOFTWARE',
  'MARKETING',
  'TRAVEL',
  'UTILITIES',
  'RENT',
  'TAX',
  'BANK_FEES',
]);

/**
 * Whether a category is surprising for the direction of money movement:
 * a credit labelled as an expense, or a debit labelled as revenue.
 */
export function isUnexpectedForDirection(
  category: Category,
  direction: Direction,
): boolean {
  if (direction === 'CREDIT') return EXPENSE_CATEGORIES.has(category);
  return category === 'REVENUE';
}
