import { z } from 'zod';
import {
  Category,
  ClassificationStatus,
  Direction,
} from '../generated/prisma/enums.js';
import {
  DECIMAL_AMOUNT,
  parseAmountToMinor,
  SUPPORTED_CURRENCIES,
} from '../common/money.js';

const upper = (v: unknown) =>
  typeof v === 'string' ? v.trim().toUpperCase() : v;

/**
 * Amounts must be decimal strings. A JSON number like 12999.75 is rejected
 * on purpose: it has already been through binary floating point by the time
 * we see it, and silently accepting it would hide precision bugs upstream.
 */
const amountField = z
  .string({
    error:
      'amount must be a decimal string such as "12999.75", not a JSON number',
  })
  .trim()
  .regex(
    DECIMAL_AMOUNT,
    'amount must be a positive decimal with at most 2 decimal places, e.g. "12999.75"',
  )
  .meta({
    description:
      'Decimal string in major units, at most 2 decimal places. JSON numbers are rejected to avoid floating-point loss.',
    examples: ['12999.75'],
  })
  .transform((v) => parseAmountToMinor(v))
  .refine((minor) => minor > 0n, 'amount must be greater than zero');

/**
 * Accepts an ISO date ("2026-11-03", interpreted as midnight in Lagos) or an
 * ISO date-time with an explicit offset.
 */
const dateField = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: 'date must be an ISO date (YYYY-MM-DD) or date-time with offset',
  })
  .meta({
    description:
      'ISO date (read as midnight in Africa/Lagos) or ISO date-time with offset. At most one day in the future.',
    examples: ['2026-11-03'],
  })
  .transform((v) => new Date(v.length === 10 ? `${v}T00:00:00+01:00` : v))
  .refine((d) => d.getUTCFullYear() >= 2000, 'date is too far in the past')
  .refine(
    (d) => d.getTime() <= Date.now() + 24 * 60 * 60 * 1000,
    'date cannot be in the future',
  );

export const transactionInputSchema = z.object({
  externalReference: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .meta({
      description:
        "The bank's reference. Unique per account; re-sending it is idempotent.",
      examples: ['GTB-2026-11-000123'],
    }),
  accountId: z
    .uuid()
    .meta({ description: 'One of your accounts (GET /api/accounts).' }),
  amount: amountField,
  currency: z
    .preprocess(upper, z.enum(SUPPORTED_CURRENCIES as [string, ...string[]]))
    .default('NGN'),
  direction: z.preprocess(upper, z.enum(Direction)),
  description: z.string().trim().min(1).max(500),
  merchant: z.string().trim().min(1).max(200).optional(),
  date: dateField,
});
export type TransactionInput = z.infer<typeof transactionInputSchema>;

export const MAX_BATCH_SIZE = 1000;

/** JSON Schema of one import item as the client sends it, for documentation. */
const { $schema: _ignored, ...transactionItemDoc } = z.toJSONSchema(
  transactionInputSchema,
  {
    io: 'input',
    unrepresentable: 'any',
  },
);

/**
 * The envelope is validated strictly; items are validated one by one so one
 * bad row cannot sink the batch. Items are typed `unknown` for that reason,
 * with the item schema attached as documentation.
 */
export const batchImportSchema = z.object({
  transactions: z
    .array(z.unknown().meta(transactionItemDoc))
    .min(1)
    .max(MAX_BATCH_SIZE)
    .meta({ description: '1–1000 transactions; each gets its own result.' }),
});

const optionalAmount = z
  .string()
  .trim()
  .regex(DECIMAL_AMOUNT, 'must be a decimal amount')
  .meta({ description: 'Decimal string in naira, e.g. "1000000.00"' })
  .transform((v) => parseAmountToMinor(v))
  .optional();

const optionalDate = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .meta({ description: 'ISO date (YYYY-MM-DD) or date-time with offset' })
  .transform((v) => new Date(v.length === 10 ? `${v}T00:00:00+01:00` : v))
  .optional();

export const listTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z
    .string()
    .max(200)
    .meta({ description: '`pageInfo.nextCursor` from the previous page' })
    .optional(),
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .meta({
      description:
        'Case-insensitive search in description, merchant and reference',
    })
    .optional(),
  accountId: z.uuid().optional(),
  direction: z.preprocess(upper, z.enum(Direction)).optional(),
  /** A category, or UNCATEGORISED for transactions with none yet. */
  category: z
    .preprocess(upper, z.enum([...Object.values(Category), 'UNCATEGORISED']))
    .optional(),
  classificationStatus: z
    .preprocess(upper, z.enum(ClassificationStatus))
    .optional(),
  /** true: only transactions with an open review flag. */
  flagged: z
    .enum(['true', 'false'])
    .meta({
      description:
        'true: only transactions with an open review flag; false: only those without',
    })
    .transform((v) => v === 'true')
    .optional(),
  from: optionalDate,
  to: optionalDate,
  minAmount: optionalAmount,
  maxAmount: optionalAmount,
});
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

export const correctCategorySchema = z.object({
  category: z.preprocess(upper, z.enum(Category)),
  note: z.string().trim().max(1000).optional(),
  /** Optimistic concurrency: reject if someone else changed the transaction first. */
  expectedVersion: z.number().int().positive().optional(),
});
export type CorrectCategoryInput = z.infer<typeof correctCategorySchema>;

export const uuidParam = z.uuid({ error: 'id must be a UUID' });
