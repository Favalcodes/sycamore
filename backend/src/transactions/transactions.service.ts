import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { z } from 'zod';
import type { Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RulesClassifier } from '../classification/rules-classifier.js';
import { decideAtIngest } from '../classification/ingest-decisions.js';
import { descriptionKey } from '../classification/decision-memory.js';
import { CATEGORY_LABELS } from '../classification/categories.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { toMoneyDto } from '../common/money.js';
import {
  CorrectCategoryInput,
  ListTransactionsQuery,
  TransactionInput,
  transactionInputSchema,
} from './transaction.schemas.js';
import {
  toTransactionSummary,
  transactionListSelect,
} from './transaction.mapper.js';

export type ImportItemStatus = 'created' | 'duplicate' | 'rejected';
export type RejectionCode =
  | 'VALIDATION_FAILED'
  | 'DUPLICATE_IN_BATCH'
  | 'ACCOUNT_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'REFERENCE_CONFLICT';

export interface ImportItemResult {
  index: number;
  status: ImportItemStatus;
  externalReference?: string;
  transactionId?: string;
  code?: RejectionCode;
  errors?: string[];
}

export interface ImportResult {
  batchId: string | null;
  total: number;
  created: number;
  duplicates: number;
  rejected: number;
  results: ImportItemResult[];
}

const CLASSIFICATION_FLAG_TYPES = [
  'LOW_CONFIDENCE',
  'UNEXPECTED_CATEGORY',
  'CLASSIFICATION_FAILED',
] as const;

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) =>
    i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
  );
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);
  private readonly rules = new RulesClassifier();
  private readonly rulesAccept: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.rulesAccept = config.get('RULES_ACCEPT_CONFIDENCE', { infer: true });
  }

  /**
   * Imports 1..1000 transactions with per-item outcomes.
   *
   * - Each item is validated on its own; invalid items are reported, valid
   *   ones still import (partial success).
   * - Idempotent on (account, externalReference): a re-sent transaction is
   *   reported as `duplicate` with the existing id, never stored twice. The
   *   database unique constraint makes this hold under concurrent requests too;
   *   INSERT ... ON CONFLICT DO NOTHING lets the loser of a race skip cleanly.
   * - Re-using a reference with different details is a `REFERENCE_CONFLICT`,
   *   not a silent overwrite.
   * - Confident rule matches are categorised immediately; everything else is
   *   queued for AI classification. No external call happens on this path, so
   *   ingestion never waits on, or fails because of, the AI provider.
   */
  async importTransactions(
    user: AuthUser,
    items: unknown[],
  ): Promise<ImportResult> {
    const db = this.prisma.forTenant(user.organisationId);
    const results = Array.from({ length: items.length }) as ImportItemResult[];
    const valid: Array<{ index: number; input: TransactionInput }> = [];
    const seen = new Map<string, number>();

    items.forEach((raw, index) => {
      const parsed = transactionInputSchema.safeParse(raw);
      const ref = (raw as { externalReference?: unknown })?.externalReference;
      if (!parsed.success) {
        results[index] = {
          index,
          status: 'rejected',
          externalReference: typeof ref === 'string' ? ref : undefined,
          code: 'VALIDATION_FAILED',
          errors: formatIssues(parsed.error),
        };
        return;
      }
      const key = `${parsed.data.accountId}|${parsed.data.externalReference}`;
      const first = seen.get(key);
      if (first !== undefined) {
        results[index] = {
          index,
          status: 'rejected',
          externalReference: parsed.data.externalReference,
          code: 'DUPLICATE_IN_BATCH',
          errors: [
            `Same accountId and externalReference as item ${first} in this batch`,
          ],
        };
        return;
      }
      seen.set(key, index);
      valid.push({ index, input: parsed.data });
    });

    // Accounts are looked up through the tenant client: another organisation's
    // account id is indistinguishable from a non-existent one.
    const accountIds = [...new Set(valid.map((v) => v.input.accountId))];
    const accounts = accountIds.length
      ? await db.account.findMany({
          where: { id: { in: accountIds } },
          select: { id: true, currency: true },
        })
      : [];
    const accountCurrency = new Map(accounts.map((a) => [a.id, a.currency]));

    const insertable = valid.filter(({ index, input }) => {
      const currency = accountCurrency.get(input.accountId);
      if (!currency) {
        results[index] = {
          index,
          status: 'rejected',
          externalReference: input.externalReference,
          code: 'ACCOUNT_NOT_FOUND',
          errors: [
            `accountId: no account ${input.accountId} in your organisation`,
          ],
        };
        return false;
      }
      if (currency !== input.currency) {
        results[index] = {
          index,
          status: 'rejected',
          externalReference: input.externalReference,
          code: 'CURRENCY_MISMATCH',
          errors: [
            `currency: ${input.currency} does not match the account currency ${currency}`,
          ],
        };
        return false;
      }
      return true;
    });

    if (insertable.length === 0) {
      return this.summarise(null, results);
    }

    const batchId = await db.$transaction(
      async (tx) => {
        const batch = await tx.importBatch.create({
          data: {
            organisationId: user.organisationId,
            createdById: user.userId,
            totalCount: items.length,
          },
          select: { id: true },
        });

        const rowKey = (accountId: string, ref: string) =>
          `${accountId}|${ref}`;
        const decisions = await decideAtIngest(
          tx,
          user.organisationId,
          insertable.map(({ input }) => ({
            ref: rowKey(input.accountId, input.externalReference),
            description: input.description,
            merchant: input.merchant ?? null,
            direction: input.direction,
            amountMinor: input.amount,
            currency: input.currency,
          })),
          this.rules,
          this.rulesAccept,
        );

        const rows: Prisma.TransactionCreateManyInput[] = insertable.map(
          ({ input }) => {
            const decision = decisions.get(
              rowKey(input.accountId, input.externalReference),
            );
            return {
              organisationId: user.organisationId,
              accountId: input.accountId,
              externalReference: input.externalReference,
              amountMinor: input.amount,
              currency: input.currency,
              direction: input.direction,
              description: input.description,
              descriptionKey: descriptionKey(input.description),
              merchant: input.merchant ?? null,
              transactionDate: input.date,
              importBatchId: batch.id,
              ...(decision
                ? {
                    category: decision.category,
                    categorySource: decision.source,
                    categoryConfidence: decision.confidence,
                    classificationStatus: 'CLASSIFIED' as const,
                  }
                : {}),
            };
          },
        );

        const created = await tx.transaction.createManyAndReturn({
          data: rows,
          skipDuplicates: true,
          select: { id: true, accountId: true, externalReference: true },
        });

        const createdByKey = new Map(
          created.map((c) => [rowKey(c.accountId, c.externalReference), c.id]),
        );
        const events: Prisma.ClassificationEventCreateManyInput[] = [];
        for (const [key, id] of createdByKey) {
          const decision = decisions.get(key);
          if (decision) {
            events.push({
              organisationId: user.organisationId,
              transactionId: id,
              category: decision.category,
              source: decision.source,
              provider: decision.provider,
              confidence: decision.confidence,
              rationale: decision.rationale,
            });
          }
        }
        if (events.length)
          await tx.classificationEvent.createMany({ data: events });

        // Rows that hit the unique constraint: idempotent replay or conflicting reuse?
        const skipped = insertable.filter(
          ({ input }) =>
            !createdByKey.has(`${input.accountId}|${input.externalReference}`),
        );
        const existing = skipped.length
          ? await tx.transaction.findMany({
              where: {
                OR: skipped.map(({ input }) => ({
                  accountId: input.accountId,
                  externalReference: input.externalReference,
                })),
              },
              select: {
                id: true,
                accountId: true,
                externalReference: true,
                amountMinor: true,
                direction: true,
                currency: true,
                description: true,
                transactionDate: true,
              },
            })
          : [];
        const existingByKey = new Map(
          existing.map((e) => [`${e.accountId}|${e.externalReference}`, e]),
        );

        let duplicates = 0;
        for (const { index, input } of insertable) {
          const key = `${input.accountId}|${input.externalReference}`;
          const createdId = createdByKey.get(key);
          if (createdId) {
            results[index] = {
              index,
              status: 'created',
              externalReference: input.externalReference,
              transactionId: createdId,
            };
            continue;
          }
          const prior = existingByKey.get(key);
          const differences = prior
            ? this.differences(prior, input)
            : ['unknown'];
          if (prior && differences.length === 0) {
            duplicates += 1;
            results[index] = {
              index,
              status: 'duplicate',
              externalReference: input.externalReference,
              transactionId: prior.id,
            };
          } else {
            results[index] = {
              index,
              status: 'rejected',
              externalReference: input.externalReference,
              transactionId: prior?.id,
              code: 'REFERENCE_CONFLICT',
              errors: [
                `externalReference ${input.externalReference} already exists on this account with a different ${differences.join(', ')}`,
              ],
            };
          }
        }

        await tx.importBatch.update({
          where: { id: batch.id },
          data: {
            createdCount: created.length,
            duplicateCount: duplicates,
            rejectedCount: items.length - created.length - duplicates,
          },
        });
        return batch.id;
      },
      { timeout: 30_000 },
    );

    const summary = this.summarise(batchId, results);
    this.logger.log({
      msg: 'Transactions imported',
      organisationId: user.organisationId,
      batchId,
      total: summary.total,
      created: summary.created,
      duplicates: summary.duplicates,
      rejected: summary.rejected,
    });
    return summary;
  }

  private differences(
    prior: {
      amountMinor: bigint;
      direction: string;
      currency: string;
      description: string;
      transactionDate: Date;
    },
    input: TransactionInput,
  ): string[] {
    const diffs: string[] = [];
    if (prior.amountMinor !== input.amount) diffs.push('amount');
    if (prior.direction !== input.direction) diffs.push('direction');
    if (prior.currency !== input.currency) diffs.push('currency');
    if (prior.description !== input.description) diffs.push('description');
    if (prior.transactionDate.getTime() !== input.date.getTime())
      diffs.push('date');
    return diffs;
  }

  private summarise(
    batchId: string | null,
    results: ImportItemResult[],
  ): ImportResult {
    const count = (s: ImportItemStatus) =>
      results.filter((r) => r.status === s).length;
    return {
      batchId,
      total: results.length,
      created: count('created'),
      duplicates: count('duplicate'),
      rejected: count('rejected'),
      results,
    };
  }

  /**
   * Keyset-paginated listing, newest first. Every filter maps onto an index
   * (see schema.prisma); free-text search uses trigram GIN indexes.
   * No total count: COUNT(*) over millions of rows per page view is the
   * classic way to make a list endpoint slow. The client gets `hasMore`.
   */
  async list(organisationId: string, query: ListTransactionsQuery) {
    const db = this.prisma.forTenant(organisationId);
    const and: Prisma.TransactionWhereInput[] = [];

    if (query.accountId) and.push({ accountId: query.accountId });
    if (query.direction) and.push({ direction: query.direction });
    if (query.category === 'UNCATEGORISED') and.push({ category: null });
    else if (query.category) and.push({ category: query.category });
    if (query.classificationStatus)
      and.push({ classificationStatus: query.classificationStatus });
    if (query.flagged === true)
      and.push({ reviewFlags: { some: { status: 'OPEN' } } });
    if (query.flagged === false)
      and.push({ reviewFlags: { none: { status: 'OPEN' } } });
    if (query.from) and.push({ transactionDate: { gte: query.from } });
    if (query.to) and.push({ transactionDate: { lte: query.to } });
    if (query.minAmount !== undefined)
      and.push({ amountMinor: { gte: query.minAmount } });
    if (query.maxAmount !== undefined)
      and.push({ amountMinor: { lte: query.maxAmount } });
    if (query.q) {
      and.push({
        OR: [
          { description: { contains: query.q, mode: 'insensitive' } },
          { merchant: { contains: query.q, mode: 'insensitive' } },
          { externalReference: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      and.push({
        OR: [
          { transactionDate: { lt: c.date } },
          { transactionDate: c.date, id: { lt: c.id } },
        ],
      });
    }

    const rows = await db.transaction.findMany({
      where: { AND: and },
      orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: transactionListSelect,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);
    return {
      data: page.map(toTransactionSummary),
      pageInfo: {
        limit: query.limit,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({ date: last.transactionDate, id: last.id })
            : null,
      },
    };
  }

  async getById(organisationId: string, id: string) {
    const db = this.prisma.forTenant(organisationId);
    const row = await db.transaction.findUnique({
      where: { id },
      select: {
        ...transactionListSelect,
        lastClassificationError: true,
        classificationAttempts: true,
        importBatchId: true,
        account: {
          select: { name: true, bankName: true, accountNumber: true },
        },
        reviewFlags: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            status: true,
            reason: true,
            details: true,
            relatedTransactionId: true,
            createdAt: true,
            resolvedAt: true,
            resolutionNote: true,
            resolvedBy: { select: { id: true, name: true } },
          },
        },
        classificationEvents: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            category: true,
            previousCategory: true,
            source: true,
            provider: true,
            confidence: true,
            rationale: true,
            createdAt: true,
            actor: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });
    // 404, not 403, for other organisations' ids: existence is not disclosed.
    if (!row) throw new NotFoundException('Transaction not found');

    const history = row.classificationEvents.map((e) => ({
      id: e.id,
      category: e.category,
      categoryLabel: CATEGORY_LABELS[e.category],
      previousCategory: e.previousCategory,
      source: e.source,
      provider: e.provider,
      confidence: e.confidence === null ? null : Number(e.confidence),
      rationale: e.rationale,
      actor: e.actor,
      createdAt: e.createdAt.toISOString(),
    }));
    const original = history.find((e) => e.source !== 'MANUAL') ?? null;
    const lastManual =
      [...history].reverse().find((e) => e.source === 'MANUAL') ?? null;

    return {
      ...toTransactionSummary({
        ...row,
        reviewFlags: row.reviewFlags.filter((f) => f.status === 'OPEN'),
      }),
      account: {
        id: row.accountId,
        name: row.account.name,
        bankName: row.account.bankName,
        accountNumberMasked: `••••${row.account.accountNumber.slice(-4)}`,
      },
      classification: {
        attempts: row.classificationAttempts,
        lastError: row.lastClassificationError,
        original,
        correction: lastManual
          ? {
              by: lastManual.actor,
              at: lastManual.createdAt,
              from: lastManual.previousCategory,
              note: lastManual.rationale,
            }
          : null,
        history,
      },
      flags: row.reviewFlags.map((f) => ({
        ...f,
        createdAt: f.createdAt.toISOString(),
        resolvedAt: f.resolvedAt?.toISOString() ?? null,
      })),
      importBatchId: row.importBatchId,
    };
  }

  /**
   * Manual correction. The automated decision is never overwritten in the
   * audit trail: a new MANUAL event records who, when, from what, and why.
   * Flags that were about the category are resolved by the correction.
   */
  async correctCategory(
    user: AuthUser,
    id: string,
    input: CorrectCategoryInput,
  ) {
    const db = this.prisma.forTenant(user.organisationId);
    await db.$transaction(async (tx) => {
      const current = await tx.transaction.findUnique({
        where: { id },
        select: { id: true, category: true, version: true },
      });
      if (!current) throw new NotFoundException('Transaction not found');
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== current.version
      ) {
        throw new ConflictException(
          'This transaction was changed by someone else since you loaded it. Reload and try again.',
        );
      }

      const updated = await tx.transaction.updateMany({
        where: { id, version: current.version },
        data: {
          category: input.category,
          categorySource: 'MANUAL',
          categoryConfidence: null,
          classificationStatus: 'CLASSIFIED',
          classificationLeaseUntil: null,
          lastClassificationError: null,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new ConflictException(
          'This transaction was changed concurrently. Reload and try again.',
        );
      }

      await tx.classificationEvent.create({
        data: {
          organisationId: user.organisationId,
          transactionId: id,
          category: input.category,
          previousCategory: current.category,
          source: 'MANUAL',
          provider: 'manual',
          rationale: input.note ?? null,
          actorUserId: user.userId,
        },
      });

      await tx.reviewFlag.updateMany({
        where: {
          transactionId: id,
          status: 'OPEN',
          type: { in: [...CLASSIFICATION_FLAG_TYPES] },
        },
        data: {
          status: 'RESOLVED',
          resolvedById: user.userId,
          resolvedAt: new Date(),
          resolutionNote: `Resolved by manual correction to ${CATEGORY_LABELS[input.category]}`,
        },
      });
    });

    return this.getById(user.organisationId, id);
  }

  /** Accounts for filters and import forms, with per-account balances of imported activity. */
  async listAccounts(organisationId: string) {
    const db = this.prisma.forTenant(organisationId);
    const accounts = await db.account.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        bankName: true,
        accountNumber: true,
        currency: true,
      },
    });
    const totals = await db.transaction.groupBy({
      by: ['accountId', 'direction'],
      _sum: { amountMinor: true },
      _count: { _all: true },
    });
    return accounts.map((a) => {
      const inflow = totals.find(
        (t) => t.accountId === a.id && t.direction === 'CREDIT',
      );
      const outflow = totals.find(
        (t) => t.accountId === a.id && t.direction === 'DEBIT',
      );
      return {
        id: a.id,
        name: a.name,
        bankName: a.bankName,
        accountNumberMasked: `••••${a.accountNumber.slice(-4)}`,
        currency: a.currency,
        transactionCount:
          (inflow?._count._all ?? 0) + (outflow?._count._all ?? 0),
        inflow: toMoneyDto(inflow?._sum.amountMinor ?? 0n, a.currency),
        outflow: toMoneyDto(outflow?._sum.amountMinor ?? 0n, a.currency),
      };
    });
  }
}
