import type { Prisma } from '../generated/prisma/client.js';
import type {
  Category,
  Direction,
  FlagType,
} from '../generated/prisma/enums.js';
import {
  CATEGORY_LABELS,
  isUnexpectedForDirection,
} from '../classification/categories.js';
import { displayMoney } from '../common/money.js';

/** A flag a detector wants raised. `reason` is shown verbatim to reviewers. */
export interface FlagDraft {
  type: FlagType;
  reason: string;
  details: Prisma.InputJsonValue;
  relatedTransactionId?: string;
}

export interface DetectionSubject {
  id: string;
  organisationId: string;
  accountId: string;
  amountMinor: bigint;
  currency: string;
  direction: Direction;
  description: string;
  transactionDate: Date;
  createdAt: Date;
}

/** Anything that can run raw SQL: the root client or an interactive transaction. */
type Sql = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface DetectionConfig {
  largeAmountAbsoluteMinor: bigint;
  largeAmountMultiplier: number;
  /** Below this amount repeated identical charges (SMS alerts, stamp duty) are normal. */
  duplicateMinAmountMinor: bigint;
}

const DUPLICATE_WINDOW_DAYS = 3;
const DUPLICATE_MIN_SIMILARITY = 0.5;
const LARGE_AMOUNT_LOOKBACK_DAYS = 90;
const LARGE_AMOUNT_MIN_HISTORY = 10;
const LARGE_AMOUNT_RELATIVE_FLOOR_MINOR = 1_000_000_00n; // ₦1,000,000

const dateFmt = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
});
const dirWord = (d: Direction) => (d === 'CREDIT' ? 'credit' : 'debit');

/**
 * Possible duplicate: same account, amount and direction, a similar
 * description (pg_trgm similarity) within a few days, but a different external
 * reference — so the idempotency key did not catch it. Exact re-imports are
 * already stopped by the unique constraint; this catches the same payment
 * entered twice through different channels.
 *
 * Only the later-imported row of a pair is flagged, so a pair yields one flag.
 */
export async function detectPossibleDuplicate(
  sql: Sql,
  t: DetectionSubject,
  config: DetectionConfig,
): Promise<FlagDraft | null> {
  if (t.amountMinor < config.duplicateMinAmountMinor) return null;

  const matches = await sql.$queryRaw<
    Array<{
      id: string;
      external_reference: string;
      transaction_date: Date;
      similarity: number;
    }>
  >`
    SELECT id, external_reference, transaction_date,
           similarity(lower(description), lower(${t.description}))::float8 AS similarity
    FROM transactions
    WHERE organisation_id = ${t.organisationId}::uuid
      AND account_id = ${t.accountId}::uuid
      AND amount_minor = ${t.amountMinor}
      AND direction = ${t.direction}::"Direction"
      AND id <> ${t.id}::uuid
      AND transaction_date BETWEEN ${t.transactionDate}::timestamptz - make_interval(days => ${DUPLICATE_WINDOW_DAYS}::int)
                               AND ${t.transactionDate}::timestamptz + make_interval(days => ${DUPLICATE_WINDOW_DAYS}::int)
      AND (created_at, id) < (${t.createdAt}::timestamptz, ${t.id}::uuid)
      AND similarity(lower(description), lower(${t.description})) >= ${DUPLICATE_MIN_SIMILARITY}::float8
    ORDER BY similarity DESC, abs(extract(epoch FROM transaction_date - ${t.transactionDate}::timestamptz))
    LIMIT 1
  `;
  const match = matches[0];
  if (!match) return null;

  const daysApart = Math.round(
    Math.abs(match.transaction_date.getTime() - t.transactionDate.getTime()) /
      86_400_000,
  );
  const when =
    daysApart === 0
      ? 'on the same day'
      : `${daysApart} day${daysApart === 1 ? '' : 's'} apart`;
  return {
    type: 'POSSIBLE_DUPLICATE',
    relatedTransactionId: match.id,
    reason:
      `Possible duplicate of ${match.external_reference} (${dateFmt.format(match.transaction_date)}): ` +
      `same account, same ${displayMoney(t.amountMinor, t.currency)} ${dirWord(t.direction)}, ` +
      `a near-identical description, ${when} — but a different reference. Confirm it was not paid twice.`,
    details: {
      matchedTransactionId: match.id,
      matchedExternalReference: match.external_reference,
      descriptionSimilarity: Math.round(match.similarity * 100) / 100,
      daysApart,
    },
  };
}

/**
 * Unusually large amount, two ways:
 *  - absolute: at or above the organisation-wide review threshold;
 *  - relative: much larger than anything this account has moved in the same
 *    direction recently. Comparing to the recent maximum (not the average)
 *    means recurring large items like payroll or rent stop being "unusual"
 *    after their first occurrence.
 */
export async function detectLargeAmount(
  sql: Sql,
  t: DetectionSubject,
  config: DetectionConfig,
): Promise<FlagDraft | null> {
  const money = displayMoney(t.amountMinor, t.currency);

  if (t.amountMinor >= config.largeAmountAbsoluteMinor) {
    return {
      type: 'LARGE_AMOUNT',
      reason: `${money} ${dirWord(t.direction)} is at or above the ${displayMoney(config.largeAmountAbsoluteMinor, t.currency)} review threshold for single transactions.`,
      details: {
        rule: 'absolute',
        thresholdMinor: config.largeAmountAbsoluteMinor.toString(),
      },
    };
  }

  if (t.amountMinor < LARGE_AMOUNT_RELATIVE_FLOOR_MINOR) return null;

  const [history] = await sql.$queryRaw<
    Array<{ max_prior: bigint | null; n: number }>
  >`
    SELECT max(amount_minor) AS max_prior, count(*)::int AS n
    FROM transactions
    WHERE organisation_id = ${t.organisationId}::uuid
      AND account_id = ${t.accountId}::uuid
      AND direction = ${t.direction}::"Direction"
      AND id <> ${t.id}::uuid
      AND transaction_date >= ${t.transactionDate}::timestamptz - make_interval(days => ${LARGE_AMOUNT_LOOKBACK_DAYS}::int)
      AND transaction_date < ${t.transactionDate}::timestamptz
  `;
  if (
    !history ||
    history.n < LARGE_AMOUNT_MIN_HISTORY ||
    history.max_prior === null
  )
    return null;

  const maxPrior = BigInt(history.max_prior);
  // Compare in integers: amount * 100 > maxPrior * round(multiplier * 100).
  const multiplierBp = BigInt(Math.round(config.largeAmountMultiplier * 100));
  if (t.amountMinor * 100n <= maxPrior * multiplierBp) return null;

  const ratio = Number((t.amountMinor * 10n) / maxPrior) / 10;
  return {
    type: 'LARGE_AMOUNT',
    reason:
      `${money} ${dirWord(t.direction)} is ${ratio}× the largest ${dirWord(t.direction)} on this account in the previous ` +
      `${LARGE_AMOUNT_LOOKBACK_DAYS} days (${displayMoney(maxPrior, t.currency)} across ${history.n} transactions).`,
    details: {
      rule: 'relative',
      largestPriorMinor: maxPrior.toString(),
      ratio,
      lookbackDays: LARGE_AMOUNT_LOOKBACK_DAYS,
      sampleSize: history.n,
    },
  };
}

/** Raised after an automated classification the model was unsure about. */
export function lowConfidenceFlag(
  category: Category,
  confidence: number,
  threshold: number,
  provider: string,
  rationale: string,
): FlagDraft {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return {
    type: 'LOW_CONFIDENCE',
    reason:
      `Categorised as ${CATEGORY_LABELS[category]} with only ${pct(confidence)} confidence ` +
      `(review threshold ${pct(threshold)}).` +
      (rationale ? ` Classifier's reasoning: "${rationale}".` : ''),
    details: { category, confidence, threshold, provider },
  };
}

/** Raised when the category contradicts the direction of money movement. */
export function unexpectedCategoryFlag(
  category: Category,
  direction: Direction,
): FlagDraft | null {
  if (!isUnexpectedForDirection(category, direction)) return null;
  const reason =
    direction === 'CREDIT'
      ? `Money came in, but it was categorised as ${CATEGORY_LABELS[category]}, which is normally an expense. It may be a refund, reversal or misclassification.`
      : `Money went out, but it was categorised as Revenue. It may be a customer refund or a misclassification.`;
  return {
    type: 'UNEXPECTED_CATEGORY',
    reason,
    details: { category, direction },
  };
}

export function classificationFailedFlag(
  attempts: number,
  lastError: string,
  fallback: Category,
): FlagDraft {
  return {
    type: 'CLASSIFICATION_FAILED',
    reason:
      `Automatic categorisation failed after ${attempts} attempts (last error: ${lastError}). ` +
      `A best-effort category of ${CATEGORY_LABELS[fallback]} was applied; please confirm it.`,
    details: { attempts, lastError, fallbackCategory: fallback },
  };
}
