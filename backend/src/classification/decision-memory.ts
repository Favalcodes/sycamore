import type { Prisma } from '../generated/prisma/client.js';
import type {
  Category,
  CategorySource,
  Direction,
} from '../generated/prisma/enums.js';

/**
 * Normalises a description so recurring payments share a key:
 *   "NIP TRF FROM BUKKA HUT/INV-20431"  ->  "nip trf from bukka hut inv #"
 *   "PAYSTACK SETTLEMENT 2026-11-12"    ->  "paystack settlement # # #"
 */
export function descriptionKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^a-z#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

export interface RecalledDecision {
  transactionId: string;
  externalReference: string;
  category: Category;
  source: CategorySource;
  confidence: number;
}

type Sql = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Only AI decisions at least this confident are reused. Human decisions always are. */
export const RECALL_MIN_AI_CONFIDENCE = 0.8;

export const memoryKey = (direction: Direction, key: string) =>
  `${direction}|${key}`;

/**
 * "Have we already decided this?" Most business transactions recur — payroll,
 * rent, the same supplier, the same customer. Reusing an earlier decision on an
 * identical (normalised) description avoids paying the model for the same
 * answer again, keeps recurring items consistent, and makes a reviewer's
 * correction apply to future occurrences.
 *
 * A decision is reused only if it was made by a person, or by the AI with high
 * confidence and no open doubt about it (no open low-confidence/unexpected flag).
 * Human decisions win over AI ones; newer wins over older.
 */
export async function recallDecisions(
  sql: Sql,
  organisationId: string,
  keys: string[],
): Promise<Map<string, RecalledDecision>> {
  const unique = [...new Set(keys)];
  const recalled = new Map<string, RecalledDecision>();
  if (unique.length === 0) return recalled;

  const rows = await sql.$queryRaw<
    Array<{
      id: string;
      external_reference: string;
      direction: Direction;
      description_key: string;
      category: Category;
      category_source: CategorySource;
      category_confidence: string | null;
    }>
  >`
    SELECT DISTINCT ON (t.direction, t.description_key)
           t.id, t.external_reference, t.direction, t.description_key,
           t.category, t.category_source, t.category_confidence::text
    FROM transactions t
    WHERE t.organisation_id = ${organisationId}::uuid
      AND t.description_key = ANY(${unique}::text[])
      AND t.classification_status = 'CLASSIFIED'
      AND (
        t.category_source = 'MANUAL'
        OR (t.category_source = 'AI' AND t.category_confidence >= ${RECALL_MIN_AI_CONFIDENCE}::numeric)
      )
      AND NOT EXISTS (
        SELECT 1 FROM review_flags f
        WHERE f.transaction_id = t.id AND f.status = 'OPEN'
          AND f.type IN ('LOW_CONFIDENCE', 'UNEXPECTED_CATEGORY', 'CLASSIFICATION_FAILED')
      )
    ORDER BY t.direction, t.description_key, (t.category_source = 'MANUAL') DESC, t.updated_at DESC
  `;

  for (const r of rows) {
    recalled.set(memoryKey(r.direction, r.description_key), {
      transactionId: r.id,
      externalReference: r.external_reference,
      category: r.category,
      source: r.category_source,
      confidence:
        r.category_source === 'MANUAL' ? 0.95 : Number(r.category_confidence),
    });
  }
  return recalled;
}

export function recallRationale(d: RecalledDecision): string {
  return d.source === 'MANUAL'
    ? `Same description as ${d.externalReference}, which a reviewer categorised by hand`
    : `Same description as ${d.externalReference}, classified by AI at ${Math.round(d.confidence * 100)}% confidence`;
}
