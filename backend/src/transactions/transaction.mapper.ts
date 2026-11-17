import type { Prisma } from '../generated/prisma/client.js';
import { toMoneyDto } from '../common/money.js';
import { CATEGORY_LABELS } from '../classification/categories.js';

export const transactionListSelect = {
  id: true,
  externalReference: true,
  accountId: true,
  amountMinor: true,
  currency: true,
  direction: true,
  description: true,
  merchant: true,
  transactionDate: true,
  category: true,
  categorySource: true,
  categoryConfidence: true,
  classificationStatus: true,
  version: true,
  createdAt: true,
  account: { select: { name: true, bankName: true } },
  reviewFlags: { where: { status: 'OPEN' }, select: { id: true, type: true } },
} satisfies Prisma.TransactionSelect;

type ListRow = Prisma.TransactionGetPayload<{
  select: typeof transactionListSelect;
}>;

/** Converts a DB row to the API shape: money as strings, never JS numbers. */
export function toTransactionSummary(row: ListRow) {
  return {
    id: row.id,
    externalReference: row.externalReference,
    account: {
      id: row.accountId,
      name: row.account.name,
      bankName: row.account.bankName,
    },
    amount: toMoneyDto(row.amountMinor, row.currency),
    direction: row.direction,
    description: row.description,
    merchant: row.merchant,
    date: row.transactionDate.toISOString(),
    category: row.category,
    categoryLabel: row.category ? CATEGORY_LABELS[row.category] : null,
    categorySource: row.categorySource,
    categoryConfidence:
      row.categoryConfidence === null ? null : Number(row.categoryConfidence),
    classificationStatus: row.classificationStatus,
    openFlags: row.reviewFlags,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}

export type TransactionSummary = ReturnType<typeof toTransactionSummary>;
