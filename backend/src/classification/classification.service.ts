import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { CLASSIFICATION_PROVIDER, ProviderError } from './provider.js';
import type {
  ClassificationInput,
  ClassificationProvider,
  ClassificationResult,
} from './provider.js';
import { CircuitBreaker } from './resilience/circuit-breaker.js';
import { RateLimiter } from './resilience/rate-limiter.js';
import { RuleMatch, RulesClassifier } from './rules-classifier.js';

export type ClassificationOutcome =
  | {
      kind: 'classified';
      result: ClassificationResult;
      source: 'RULES' | 'AI';
      provider: string;
    }
  | {
      kind: 'deferred';
      reason: string;
      /** Minimum wait before trying again. */
      retryAfterMs: number;
      /**
       * true only for failures that may be about this transaction (the model
       * omitted it or answered unusably). Provider-wide problems — circuit
       * open, rate limits, timeouts, outages — never use up attempts, or a
       * long outage would exhaust them.
       */
      consumesAttempt: boolean;
      /** Best rule guess, used if attempts run out. */
      fallback: RuleMatch | null;
    };

/**
 * Decides categories for a batch of transactions.
 *
 *   1. Rules first. Confident matches are final and cost nothing.
 *   2. The rest go to the AI provider in chunks, guarded by a local rate
 *      limiter (stay inside quota), a circuit breaker (stop calling a dead
 *      provider) and a hard timeout (a slow provider cannot stall the worker).
 *   3. Anything not classified comes back "deferred" with a reason; the job
 *      queue persists it and retries later. Nothing here blocks ingestion.
 */
@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);
  private readonly rules = new RulesClassifier();
  readonly breaker: CircuitBreaker;
  readonly limiter: RateLimiter;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly rulesAccept: number;

  constructor(
    @Inject(CLASSIFICATION_PROVIDER)
    private readonly provider: ClassificationProvider,
    config: ConfigService<Env, true>,
  ) {
    this.breaker = new CircuitBreaker(
      config.get('CIRCUIT_FAILURE_THRESHOLD', { infer: true }),
      config.get('CIRCUIT_OPEN_MS', { infer: true }),
    );
    this.limiter = RateLimiter.perMinute(
      config.get('AI_MAX_REQUESTS_PER_MINUTE', { infer: true }),
    );
    this.batchSize = config.get('AI_BATCH_SIZE', { infer: true });
    this.timeoutMs = config.get('AI_TIMEOUT_MS', { infer: true });
    this.rulesAccept = config.get('RULES_ACCEPT_CONFIDENCE', { infer: true });
  }

  get providerName(): string {
    return this.provider.name;
  }

  async classify(
    inputs: ClassificationInput[],
  ): Promise<Map<string, ClassificationOutcome>> {
    const outcomes = new Map<string, ClassificationOutcome>();
    const ruleGuesses = new Map<string, RuleMatch | null>();
    const needsModel: ClassificationInput[] = [];

    for (const input of inputs) {
      const match = this.rules.classify(input);
      ruleGuesses.set(input.id, match);
      if (match && match.confidence >= this.rulesAccept) {
        outcomes.set(input.id, {
          kind: 'classified',
          result: match,
          source: 'RULES',
          provider: this.rules.name,
        });
      } else {
        needsModel.push(input);
      }
    }

    for (let i = 0; i < needsModel.length; i += this.batchSize) {
      const chunk = needsModel.slice(i, i + this.batchSize);
      const defer = (
        reason: string,
        retryAfterMs: number,
        consumesAttempt: boolean,
      ) => {
        for (const input of chunk) {
          outcomes.set(input.id, {
            kind: 'deferred',
            reason,
            retryAfterMs,
            consumesAttempt,
            fallback: ruleGuesses.get(input.id) ?? null,
          });
        }
      };

      if (!this.limiter.tryTake()) {
        defer('Waiting for AI rate-limit budget', this.limiter.waitMs(), false);
        continue;
      }
      if (!this.breaker.tryAcquire()) {
        defer(
          'AI provider circuit is open after repeated failures',
          Math.max(this.breaker.retryAfterMs(), 1_000),
          false,
        );
        continue;
      }

      try {
        const results = await this.provider.classify(
          chunk,
          AbortSignal.timeout(this.timeoutMs + 1_000),
        );
        this.breaker.onSuccess();
        const byId = new Map(results.map((r) => [r.id, r]));
        for (const input of chunk) {
          const result = byId.get(input.id);
          outcomes.set(
            input.id,
            result
              ? {
                  kind: 'classified',
                  result,
                  source: 'AI',
                  provider: this.provider.name,
                }
              : {
                  kind: 'deferred',
                  reason:
                    'AI response omitted this transaction or returned an invalid result',
                  retryAfterMs: 0,
                  consumesAttempt: true,
                  fallback: ruleGuesses.get(input.id) ?? null,
                },
          );
        }
      } catch (error) {
        const err =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                'UNAVAILABLE',
                (error as Error)?.message ?? 'Unknown provider error',
              );

        if (err.kind === 'RATE_LIMITED') {
          // The provider is up, we are just over quota: pause, don't count it as a failure.
          const wait = err.retryAfterMs ?? 60_000;
          this.limiter.pause(wait);
          this.breaker.onSuccess();
          defer(err.message, wait, false);
        } else {
          this.breaker.onFailure();
          // A timeout or outage is the provider's problem, not this transaction's:
          // it is retried (the circuit breaker paces that) without using up the
          // transaction's attempts, so a long outage cannot push a backlog into
          // FAILED. A malformed answer may be specific to these inputs, so it counts.
          defer(
            `${err.kind}: ${err.message}`,
            0,
            err.kind === 'INVALID_RESPONSE',
          );
        }
        this.logger.warn({
          msg: 'AI classification call failed',
          kind: err.kind,
          provider: this.provider.name,
          batch: chunk.length,
          circuit: this.breaker.snapshot().state,
        });
      }
    }

    return outcomes;
  }

  health() {
    return {
      provider: this.provider.name,
      circuit: this.breaker.snapshot(),
      rateLimitWaitMs: this.limiter.waitMs(),
    };
  }
}
