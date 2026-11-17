import { z } from 'zod';
import { CATEGORIES } from '../categories.js';
import type { ClassificationResult } from '../provider.js';

/** One item as the model returns it. Validated, never trusted. */
const itemSchema = z.object({
  id: z.string().min(1),
  category: z
    .string()
    .transform((v) => v.trim().toUpperCase().replace(/\s+/g, '_'))
    .pipe(z.enum(CATEGORIES as [string, ...string[]])),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(1000).default(''),
});

export const modelResponseSchema = z.object({ results: z.array(z.unknown()) });

/** JSON Schema handed to the model to constrain its output. */
export const MODEL_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string' },
        },
        required: ['id', 'category', 'confidence', 'rationale'],
      },
    },
  },
  required: ['results'],
};

/**
 * Validates a model's raw output item by item. A malformed item is dropped
 * (and therefore retried later) without discarding its valid neighbours.
 * Ids the model invented are ignored.
 */
export function parseModelResults(
  raw: unknown,
  expectedIds: ReadonlySet<string>,
): { results: ClassificationResult[]; invalid: number } {
  const envelope = modelResponseSchema.safeParse(raw);
  if (!envelope.success) return { results: [], invalid: expectedIds.size };

  const results: ClassificationResult[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const item of envelope.data.results) {
    const parsed = itemSchema.safeParse(item);
    if (
      !parsed.success ||
      !expectedIds.has(parsed.data.id) ||
      seen.has(parsed.data.id)
    ) {
      invalid += 1;
      continue;
    }
    seen.add(parsed.data.id);
    results.push({
      id: parsed.data.id,
      category: parsed.data.category as ClassificationResult['category'],
      confidence: Math.round(parsed.data.confidence * 1000) / 1000,
      rationale: parsed.data.rationale.slice(0, 500),
    });
  }
  return { results, invalid };
}
