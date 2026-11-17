import type { Category, Direction } from '../generated/prisma/enums.js';

/** What a provider sees about a transaction. No tenant identifiers are sent. */
export interface ClassificationInput {
  id: string;
  description: string;
  merchant: string | null;
  direction: Direction;
  /** Decimal string in major units, e.g. "12999.75". */
  amount: string;
  currency: string;
}

export interface ClassificationResult {
  id: string;
  category: Category;
  /** 0..1 */
  confidence: number;
  rationale: string;
}

/**
 * The seam for swapping classifiers. Gemini, the mock, or any future provider
 * (OpenAI, a self-hosted model, an internal service) implements this one
 * method; nothing else in the app knows which is in use.
 *
 * Implementations must:
 *  - return results only for ids they were given (missing ids are retried);
 *  - throw `ProviderError` for transport-level failures so the caller can
 *    tell a timeout from a rate limit from a malformed response.
 */
export interface ClassificationProvider {
  /** Stable identifier recorded in the audit trail, e.g. "gemini:gemini-3.5-flash-lite". */
  readonly name: string;
  classify(
    inputs: ClassificationInput[],
    signal: AbortSignal,
  ): Promise<ClassificationResult[]>;
}

export const CLASSIFICATION_PROVIDER = Symbol('CLASSIFICATION_PROVIDER');

export type ProviderErrorKind =
  /** Took longer than our deadline. */
  | 'TIMEOUT'
  /** 5xx, network failure, auth/config problem: the provider is not usable right now. */
  | 'UNAVAILABLE'
  /** 429: back off, but the provider is healthy. */
  | 'RATE_LIMITED'
  /** Answered, but not with something we can trust. */
  | 'INVALID_RESPONSE';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** Provider-suggested wait before retrying, when it gives one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
