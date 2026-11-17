import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import type { Category, Direction } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ClassificationOutcome,
  ClassificationService,
} from '../classification/classification.service.js';
import { formatMinor } from '../common/money.js';
import {
  memoryKey,
  recallDecisions,
  recallRationale,
} from '../classification/decision-memory.js';
import {
  classificationFailedFlag,
  FlagDraft,
  lowConfidenceFlag,
  unexpectedCategoryFlag,
} from '../review/detectors.js';

interface ClaimedRow {
  id: string;
  organisation_id: string;
  description: string;
  description_key: string;
  merchant: string | null;
  direction: Direction;
  amount_minor: bigint;
  currency: string;
  category: Category | null;
  classification_attempts: number;
}

const LEASE_SECONDS = 120;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

/** Exponential backoff with ±20% jitter so retries don't arrive in a thundering herd. */
export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Drains the AI classification queue (transactions in PENDING status).
 *
 * Claiming uses a lease instead of a long-held lock: the row is marked
 * PROCESSING with a lease expiry, the slow AI call happens outside any DB
 * transaction, and if the worker dies the lease lapses and the row is claimed
 * again. Writes are conditional on the row still being PROCESSING and not
 * manually corrected, so a human edit made mid-flight always wins.
 */
@Injectable()
export class ClassificationJob {
  private readonly logger = new Logger(ClassificationJob.name);
  private readonly maxAttempts: number;
  private readonly lowConfidence: number;
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly classifier: ClassificationService,
    env: ConfigService<Env, true>,
  ) {
    this.maxAttempts = env.get('CLASSIFICATION_MAX_ATTEMPTS', { infer: true });
    this.lowConfidence = env.get('LOW_CONFIDENCE_THRESHOLD', { infer: true });
    this.batchSize = env.get('AI_BATCH_SIZE', { infer: true });
  }

  /**
   * Milliseconds to wait before it is worth claiming work again: while the
   * circuit is open or the rate budget is spent, claiming would only churn
   * rows. The backlog simply waits in PENDING, in arrival order.
   */
  pauseMs(): number {
    return Math.max(
      this.classifier.breaker.retryAfterMs(),
      this.classifier.limiter.waitMs(),
    );
  }

  async runOnce(): Promise<number> {
    if (this.pauseMs() > 0) return 0;

    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE transactions
      SET classification_status = 'PROCESSING',
          classification_lease_until = now() + make_interval(secs => ${LEASE_SECONDS}::int),
          classification_attempts = classification_attempts + 1,
          updated_at = now()
      WHERE id IN (
        SELECT id FROM transactions
        WHERE (classification_status = 'PENDING' AND next_classification_at <= now())
           OR (classification_status = 'PROCESSING' AND classification_lease_until < now())
        ORDER BY next_classification_at, id
        LIMIT ${this.batchSize}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organisation_id, description, description_key, merchant, direction, amount_minor,
                currency, category, classification_attempts
    `;
    if (rows.length === 0) return 0;

    // Earlier trusted decisions on the same description are reused without an AI call.
    let classified = 0;
    const needsClassifier: ClaimedRow[] = [];
    const byOrg = new Map<string, ClaimedRow[]>();
    for (const row of rows)
      byOrg.set(row.organisation_id, [
        ...(byOrg.get(row.organisation_id) ?? []),
        row,
      ]);
    for (const [organisationId, orgRows] of byOrg) {
      const recalled = await recallDecisions(
        this.prisma,
        organisationId,
        orgRows.map((r) => r.description_key),
      );
      for (const row of orgRows) {
        const hit = recalled.get(memoryKey(row.direction, row.description_key));
        if (!hit) {
          needsClassifier.push(row);
          continue;
        }
        classified += await this.finalise(row, {
          category: hit.category,
          source: 'LEARNED',
          provider: `history:${hit.transactionId}`,
          confidence: hit.confidence,
          rationale: recallRationale(hit),
          status: 'CLASSIFIED',
          flags: [unexpectedCategoryFlag(hit.category, row.direction)].filter(
            (f): f is FlagDraft => f !== null,
          ),
        });
      }
    }

    // Identical descriptions in the same batch are sent once; siblings share the answer.
    const representative = new Map<string, ClaimedRow>();
    for (const row of needsClassifier) {
      const key = `${row.organisation_id}|${memoryKey(row.direction, row.description_key)}`;
      if (!representative.has(key)) representative.set(key, row);
    }
    const repFor = (row: ClaimedRow) =>
      representative.get(
        `${row.organisation_id}|${memoryKey(row.direction, row.description_key)}`,
      )!;

    const outcomes = await this.classifier.classify(
      [...representative.values()].map((r) => ({
        id: r.id,
        description: r.description,
        merchant: r.merchant,
        direction: r.direction,
        amount: formatMinor(BigInt(r.amount_minor)),
        currency: r.currency,
      })),
    );

    for (const row of needsClassifier) {
      const outcome = outcomes.get(repFor(row).id);
      if (!outcome) continue;
      try {
        if (outcome.kind === 'classified') {
          classified += await this.saveClassification(row, outcome);
        } else {
          await this.saveDeferral(row, outcome);
        }
      } catch (error) {
        // Leave the lease to expire; the row will be retried.
        this.logger.error({
          msg: 'Failed to persist outcome',
          transactionId: row.id,
          err: (error as Error).message,
        });
      }
    }

    this.logger.log({
      msg: 'Classification batch',
      claimed: rows.length,
      classified,
    });
    return rows.length;
  }

  private async saveClassification(
    row: ClaimedRow,
    outcome: Extract<ClassificationOutcome, { kind: 'classified' }>,
  ): Promise<number> {
    const { result, source, provider } = outcome;
    const flags: FlagDraft[] = [];
    if (source === 'AI' && result.confidence < this.lowConfidence) {
      flags.push(
        lowConfidenceFlag(
          result.category,
          result.confidence,
          this.lowConfidence,
          provider,
          result.rationale,
        ),
      );
    }
    const unexpected = unexpectedCategoryFlag(result.category, row.direction);
    if (unexpected) flags.push(unexpected);

    return this.finalise(row, {
      category: result.category,
      source,
      provider,
      confidence: result.confidence,
      rationale: result.rationale,
      status: 'CLASSIFIED',
      flags,
    });
  }

  private async saveDeferral(
    row: ClaimedRow,
    outcome: Extract<ClassificationOutcome, { kind: 'deferred' }>,
  ) {
    const attempts = outcome.consumesAttempt
      ? row.classification_attempts
      : row.classification_attempts - 1;

    if (outcome.consumesAttempt && attempts >= this.maxAttempts) {
      const fallback = outcome.fallback?.category ?? 'OTHER';
      await this.finalise(row, {
        category: fallback,
        source: 'FALLBACK',
        provider: outcome.fallback ? 'rules:v1' : 'fallback:default',
        confidence: outcome.fallback?.confidence ?? 0,
        rationale: `AI classification failed after ${attempts} attempts; ${outcome.fallback ? outcome.fallback.rationale : 'no rule matched'}`,
        status: 'FAILED',
        flags: [classificationFailedFlag(attempts, outcome.reason, fallback)],
        lastError: outcome.reason,
      });
      return;
    }

    const delay = outcome.consumesAttempt
      ? Math.max(outcome.retryAfterMs, backoffMs(attempts))
      : Math.max(outcome.retryAfterMs, 1_000);
    await this.prisma.transaction.updateMany({
      where: { id: row.id, classificationStatus: 'PROCESSING' },
      data: {
        classificationStatus: 'PENDING',
        classificationAttempts: attempts,
        nextClassificationAt: new Date(Date.now() + delay),
        classificationLeaseUntil: null,
        lastClassificationError: outcome.reason.slice(0, 500),
      },
    });
  }

  /** Writes the decision, its audit event and any flags atomically. */
  private async finalise(
    row: ClaimedRow,
    d: {
      category: Category;
      source: 'RULES' | 'AI' | 'LEARNED' | 'FALLBACK';
      provider: string;
      confidence: number;
      rationale: string;
      status: 'CLASSIFIED' | 'FAILED';
      flags: FlagDraft[];
      lastError?: string;
    },
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.transaction.updateMany({
        where: {
          id: row.id,
          organisationId: row.organisation_id,
          classificationStatus: 'PROCESSING',
          OR: [{ categorySource: null }, { categorySource: { not: 'MANUAL' } }],
        },
        data: {
          category: d.category,
          categorySource: d.source,
          categoryConfidence: d.confidence,
          classificationStatus: d.status,
          classificationLeaseUntil: null,
          lastClassificationError: d.lastError?.slice(0, 500) ?? null,
          version: { increment: 1 },
        },
      });
      // Someone corrected it by hand while we were thinking: their decision stands.
      if (updated.count === 0) return 0;

      await tx.classificationEvent.create({
        data: {
          organisationId: row.organisation_id,
          transactionId: row.id,
          category: d.category,
          previousCategory: row.category,
          source: d.source,
          provider: d.provider,
          confidence: d.confidence,
          rationale: d.rationale.slice(0, 1000),
        },
      });
      if (d.flags.length > 0) {
        await tx.reviewFlag.createMany({
          data: d.flags.map((f) => ({
            ...f,
            organisationId: row.organisation_id,
            transactionId: row.id,
          })),
          skipDuplicates: true,
        });
      }
      return 1;
    });
  }
}
