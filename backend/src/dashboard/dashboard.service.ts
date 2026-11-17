import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toMoneyDto } from '../common/money.js';
import { CATEGORY_LABELS } from '../classification/categories.js';
import { ReviewService } from '../review/review.service.js';

const isoDate = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((v) => new Date(v.length === 10 ? `${v}T00:00:00+01:00` : v));

export const dashboardQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountId: z.uuid().optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/** Totals are reported in the organisation's primary currency. */
const REPORTING_CURRENCY = 'NGN';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly review: ReviewService,
  ) {}

  /**
   * All sums are computed by Postgres over BIGINT kobo (SUM returns numeric,
   * so no overflow) and come back as bigint — no floating point anywhere.
   * For very large tenants these aggregates would move to pre-computed daily
   * rollups; see README "Scalability".
   */
  async summary(organisationId: string, query: DashboardQuery) {
    const db = this.prisma.forTenant(organisationId);
    const where: Prisma.TransactionWhereInput = {
      currency: REPORTING_CURRENCY,
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.from || query.to
        ? {
            transactionDate: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    // Movements between the organisation's own accounts are not income or
    // spending; counting them would inflate both sides of the cash flow.
    const cashFlow: Prisma.TransactionWhereInput = {
      ...where,
      OR: [{ category: null }, { category: { not: 'TRANSFERS' } }],
    };

    const [
      byDirection,
      internal,
      byCategory,
      byStatus,
      flagSummary,
      recentFlags,
    ] = await Promise.all([
      db.transaction.groupBy({
        by: ['direction'],
        where: cashFlow,
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      db.transaction.groupBy({
        by: ['direction'],
        where: { ...where, category: 'TRANSFERS' },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      db.transaction.groupBy({
        by: ['category'],
        where: { ...cashFlow, direction: 'DEBIT' },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      db.transaction.groupBy({
        by: ['classificationStatus'],
        where,
        _count: { _all: true },
      }),
      this.review.summary(organisationId),
      this.review.listFlags(organisationId, { status: 'OPEN', limit: 8 }),
    ]);

    const inflow =
      byDirection.find((d) => d.direction === 'CREDIT')?._sum.amountMinor ?? 0n;
    const outflow =
      byDirection.find((d) => d.direction === 'DEBIT')?._sum.amountMinor ?? 0n;
    const count = byDirection.reduce((n, d) => n + d._count._all, 0);
    const internalIn =
      internal.find((d) => d.direction === 'CREDIT')?._sum.amountMinor ?? 0n;
    const internalOut =
      internal.find((d) => d.direction === 'DEBIT')?._sum.amountMinor ?? 0n;

    const spending = byCategory
      .map((c) => ({
        category: c.category,
        amount: c._sum.amountMinor ?? 0n,
        count: c._count._all,
      }))
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));

    return {
      currency: REPORTING_CURRENCY,
      period: {
        from: query.from?.toISOString() ?? null,
        to: query.to?.toISOString() ?? null,
      },
      totals: {
        inflow: toMoneyDto(inflow, REPORTING_CURRENCY),
        outflow: toMoneyDto(outflow, REPORTING_CURRENCY),
        net: toMoneyDto(inflow - outflow, REPORTING_CURRENCY),
        transactionCount: count,
      },
      internalTransfers: {
        in: toMoneyDto(internalIn, REPORTING_CURRENCY),
        out: toMoneyDto(internalOut, REPORTING_CURRENCY),
        transactionCount: internal.reduce((n, d) => n + d._count._all, 0),
      },
      spendingByCategory: spending.map((s) => ({
        category: s.category ?? 'UNCATEGORISED',
        label: s.category
          ? CATEGORY_LABELS[s.category]
          : 'Awaiting classification',
        amount: toMoneyDto(s.amount, REPORTING_CURRENCY),
        count: s.count,
        // Basis points of total outflow, computed in integers.
        shareBp: outflow > 0n ? Number((s.amount * 10_000n) / outflow) : 0,
      })),
      classification: Object.fromEntries(
        byStatus.map((s) => [s.classificationStatus, s._count._all]),
      ),
      flags: {
        open: flagSummary.open,
        byType: flagSummary.byType,
        recent: recentFlags.data,
      },
    };
  }
}
