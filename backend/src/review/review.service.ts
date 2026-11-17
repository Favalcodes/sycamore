import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { FlagStatus, FlagType } from '../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toMoneyDto } from '../common/money.js';
import { CATEGORY_LABELS } from '../classification/categories.js';

const upper = (v: unknown) =>
  typeof v === 'string' ? v.trim().toUpperCase() : v;

export const listFlagsQuerySchema = z.object({
  status: z.preprocess(upper, z.enum(FlagStatus)).default('OPEN'),
  type: z.preprocess(upper, z.enum(FlagType)).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Id of the last flag on the previous page. */
  cursor: z.uuid().optional(),
});
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;

export const resolveFlagSchema = z.object({
  status: z.preprocess(upper, z.enum(['RESOLVED', 'DISMISSED'])),
  note: z.string().trim().max(1000).optional(),
});
export type ResolveFlagInput = z.infer<typeof resolveFlagSchema>;

@Injectable()
export class ReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async listFlags(organisationId: string, query: ListFlagsQuery) {
    const db = this.prisma.forTenant(organisationId);
    const rows = await db.reviewFlag.findMany({
      where: {
        status: query.status,
        ...(query.type ? { type: query.type } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        createdAt: true,
        resolvedAt: true,
        resolutionNote: true,
        resolvedBy: { select: { id: true, name: true } },
        transaction: {
          select: {
            id: true,
            externalReference: true,
            description: true,
            amountMinor: true,
            currency: true,
            direction: true,
            transactionDate: true,
            category: true,
            categoryConfidence: true,
            account: { select: { name: true } },
          },
        },
      },
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      data: page.map((f) => ({
        id: f.id,
        type: f.type,
        status: f.status,
        reason: f.reason,
        createdAt: f.createdAt.toISOString(),
        resolvedAt: f.resolvedAt?.toISOString() ?? null,
        resolutionNote: f.resolutionNote,
        resolvedBy: f.resolvedBy,
        transaction: {
          id: f.transaction.id,
          externalReference: f.transaction.externalReference,
          description: f.transaction.description,
          amount: toMoneyDto(f.transaction.amountMinor, f.transaction.currency),
          direction: f.transaction.direction,
          date: f.transaction.transactionDate.toISOString(),
          category: f.transaction.category,
          categoryLabel: f.transaction.category
            ? CATEGORY_LABELS[f.transaction.category]
            : null,
          categoryConfidence:
            f.transaction.categoryConfidence === null
              ? null
              : Number(f.transaction.categoryConfidence),
          accountName: f.transaction.account.name,
        },
      })),
      pageInfo: {
        limit: query.limit,
        hasMore,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      },
    };
  }

  async summary(organisationId: string) {
    const db = this.prisma.forTenant(organisationId);
    const groups = await db.reviewFlag.groupBy({
      by: ['type'],
      where: { status: 'OPEN' },
      _count: { _all: true },
    });
    const byType = Object.fromEntries(
      Object.values(FlagType).map((t) => [t, 0]),
    ) as Record<FlagType, number>;
    for (const g of groups) byType[g.type] = g._count._all;
    return { open: groups.reduce((n, g) => n + g._count._all, 0), byType };
  }

  /** Close a flag as RESOLVED (acted on) or DISMISSED (false positive), recording who and why. */
  async resolve(user: AuthUser, id: string, input: ResolveFlagInput) {
    const db = this.prisma.forTenant(user.organisationId);
    const flag = await db.reviewFlag.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!flag) throw new NotFoundException('Review flag not found');
    if (flag.status !== 'OPEN')
      throw new BadRequestException(
        `Flag is already ${flag.status.toLowerCase()}`,
      );

    const updated = await db.reviewFlag.updateMany({
      where: { id, status: 'OPEN' },
      data: {
        status: input.status,
        resolvedById: user.userId,
        resolvedAt: new Date(),
        resolutionNote: input.note ?? null,
      },
    });
    if (updated.count === 0)
      throw new BadRequestException('Flag was closed by someone else');
    return db.reviewFlag.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        resolvedAt: true,
        resolutionNote: true,
        resolvedBy: { select: { id: true, name: true } },
      },
    });
  }
}
