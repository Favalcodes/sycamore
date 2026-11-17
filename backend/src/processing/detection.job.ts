import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import type { Direction } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DetectionConfig,
  DetectionSubject,
  detectLargeAmount,
  detectPossibleDuplicate,
  FlagDraft,
} from '../review/detectors.js';

interface Row {
  id: string;
  organisation_id: string;
  account_id: string;
  amount_minor: bigint;
  currency: string;
  direction: Direction;
  description: string;
  transaction_date: Date;
  created_at: Date;
}

/**
 * Runs the rule-based review detectors (duplicates, large amounts) over newly
 * imported transactions. Independent of the AI provider: an AI outage never
 * delays fraud/duplicate review.
 *
 * Rows are claimed with FOR UPDATE SKIP LOCKED inside one transaction, so
 * several workers can run concurrently without double-processing, and a crash
 * mid-batch rolls back cleanly for another worker to pick up.
 */
@Injectable()
export class DetectionJob {
  private readonly logger = new Logger(DetectionJob.name);
  private readonly config: DetectionConfig;

  constructor(
    private readonly prisma: PrismaService,
    env: ConfigService<Env, true>,
  ) {
    this.config = {
      largeAmountAbsoluteMinor:
        BigInt(env.get('LARGE_AMOUNT_ABSOLUTE_NGN', { infer: true })) * 100n,
      largeAmountMultiplier: env.get('LARGE_AMOUNT_MULTIPLIER', {
        infer: true,
      }),
      duplicateMinAmountMinor: 5_000_00n,
    };
  }

  /** Processes one batch. Returns how many transactions were checked. */
  async runOnce(batchSize = 100): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Row[]>`
          SELECT id, organisation_id, account_id, amount_minor, currency, direction,
                 description, transaction_date, created_at
          FROM transactions
          WHERE review_checked_at IS NULL
          ORDER BY created_at, id
          LIMIT ${batchSize}::int
          FOR UPDATE SKIP LOCKED
        `;
        if (rows.length === 0) return 0;

        const flags: Array<
          FlagDraft & { organisationId: string; transactionId: string }
        > = [];
        for (const row of rows) {
          const subject: DetectionSubject = {
            id: row.id,
            organisationId: row.organisation_id,
            accountId: row.account_id,
            amountMinor: BigInt(row.amount_minor),
            currency: row.currency,
            direction: row.direction,
            description: row.description,
            transactionDate: row.transaction_date,
            createdAt: row.created_at,
          };
          for (const detect of [detectPossibleDuplicate, detectLargeAmount]) {
            const flag = await detect(tx, subject, this.config);
            if (flag)
              flags.push({
                ...flag,
                organisationId: row.organisation_id,
                transactionId: row.id,
              });
          }
        }

        if (flags.length > 0) {
          await tx.reviewFlag.createMany({ data: flags, skipDuplicates: true });
        }
        await tx.transaction.updateMany({
          where: { id: { in: rows.map((r) => r.id) } },
          data: { reviewCheckedAt: new Date() },
        });

        this.logger.log({
          msg: 'Review detection batch',
          checked: rows.length,
          flagged: flags.length,
        });
        return rows.length;
      },
      { timeout: 60_000 },
    );
  }
}
