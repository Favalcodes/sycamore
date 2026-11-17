import type { Prisma } from '../generated/prisma/client.js';
import type { Category, Direction } from '../generated/prisma/enums.js';
import { formatMinor } from '../common/money.js';
import {
  descriptionKey,
  memoryKey,
  recallDecisions,
  recallRationale,
} from './decision-memory.js';
import { RulesClassifier } from './rules-classifier.js';

export interface IngestItem {
  /** Caller's identifier for mapping results back. */
  ref: string;
  description: string;
  merchant: string | null;
  direction: Direction;
  amountMinor: bigint;
  currency: string;
}

export interface IngestDecision {
  category: Category;
  source: 'RULES' | 'LEARNED';
  confidence: number;
  provider: string;
  rationale: string;
}

/**
 * Decisions that can be made at import time without any external call:
 * a confident keyword rule, or recalling an earlier trusted decision on the
 * same description. Everything else is left for the AI queue.
 */
export async function decideAtIngest(
  sql: Pick<Prisma.TransactionClient, '$queryRaw'>,
  organisationId: string,
  items: IngestItem[],
  rules: RulesClassifier,
  rulesAccept: number,
): Promise<Map<string, IngestDecision>> {
  const decisions = new Map<string, IngestDecision>();
  const undecided: IngestItem[] = [];

  for (const item of items) {
    const match = rules.classify({
      id: item.ref,
      description: item.description,
      merchant: item.merchant,
      direction: item.direction,
      amount: formatMinor(item.amountMinor),
      currency: item.currency,
    });
    if (match && match.confidence >= rulesAccept) {
      decisions.set(item.ref, {
        category: match.category,
        source: 'RULES',
        confidence: match.confidence,
        provider: rules.name,
        rationale: match.rationale,
      });
    } else {
      undecided.push(item);
    }
  }

  const recalled = await recallDecisions(
    sql,
    organisationId,
    undecided.map((i) => descriptionKey(i.description)),
  );
  for (const item of undecided) {
    const hit = recalled.get(
      memoryKey(item.direction, descriptionKey(item.description)),
    );
    if (hit) {
      decisions.set(item.ref, {
        category: hit.category,
        source: 'LEARNED',
        confidence: hit.confidence,
        provider: `history:${hit.transactionId}`,
        rationale: recallRationale(hit),
      });
    }
  }
  return decisions;
}
