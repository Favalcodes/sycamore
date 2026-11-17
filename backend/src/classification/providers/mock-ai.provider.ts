import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Category } from '../../generated/prisma/enums.js';
import {
  ClassificationInput,
  ClassificationProvider,
  ClassificationResult,
  ProviderError,
} from '../provider.js';
import { defineProvider } from './provider-definition.js';

const HINTS: Array<[RegExp, Category]> = [
  [/ads|campaign|print|flyer|branding|event/i, 'MARKETING'],
  [/fuel|\bago\b|petrol|toll|haulage|transport|ticket/i, 'TRAVEL'],
  [/software|licen[cs]e|subscription|cloud|tracking/i, 'SOFTWARE'],
  [/allowance|salary|staff/i, 'PAYROLL'],
  [/refund|reversal/i, 'OTHER'],
];

export interface MockAiOptions {
  latencyMs: number;
  /** 0..1 probability that a call fails, to rehearse outages locally. */
  failureRate: number;
  random?: () => number;
}

/**
 * Stand-in for a language model: deterministic per description, with
 * believable but imperfect confidence, configurable latency and failures.
 * Lets the full pipeline (including outages) run without an API key.
 */
export class MockAiProvider implements ClassificationProvider {
  readonly name = 'mock-ai';
  private readonly random: () => number;

  constructor(private readonly options: MockAiOptions) {
    this.random = options.random ?? Math.random;
  }

  async classify(
    inputs: ClassificationInput[],
    signal: AbortSignal,
  ): Promise<ClassificationResult[]> {
    await sleep(this.options.latencyMs, signal);

    const roll = this.random();
    if (roll < this.options.failureRate) {
      const kinds = ['TIMEOUT', 'UNAVAILABLE', 'RATE_LIMITED'] as const;
      const kind =
        kinds[
          Math.floor((roll / this.options.failureRate) * kinds.length) %
            kinds.length
        ];
      throw new ProviderError(
        kind,
        `Simulated ${kind.toLowerCase()} from mock AI`,
        kind === 'RATE_LIMITED' ? 5_000 : undefined,
      );
    }

    return inputs.map((input) => {
      const text = `${input.description} ${input.merchant ?? ''}`;
      const hint = HINTS.find(([pattern]) => pattern.test(text));
      const category: Category =
        hint?.[1] ?? (input.direction === 'CREDIT' ? 'REVENUE' : 'OTHER');
      // Stable pseudo-confidence derived from the text: fairly sure when a hint
      // matched, unsure otherwise — so low-confidence review has something to show.
      const h =
        createHash('sha256').update(text).digest().readUInt16BE(0) / 65_536;
      const confidence =
        Math.round((hint ? 0.72 + h * 0.25 : 0.3 + h * 0.4) * 1000) / 1000;
      return {
        id: input.id,
        category,
        confidence,
        rationale: hint
          ? `Text suggests ${category.toLowerCase().replace('_', ' ')}`
          : 'No strong signal in the description',
      };
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderError('TIMEOUT', 'Mock AI call aborted'));
      },
      { once: true },
    );
  });
}

export const mockAiProvider = defineProvider({
  id: 'mock',
  description:
    'Built-in mock model for local development and outage drills (no API key needed)',
  configSchema: z.object({
    MOCK_AI_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    MOCK_AI_LATENCY_MS: z.coerce.number().int().min(0).default(150),
  }),
  // Always usable, so it is the fallback when no real model is configured.
  isConfigured: () => true,
  create: (config) =>
    new MockAiProvider({
      latencyMs: config.MOCK_AI_LATENCY_MS,
      failureRate: config.MOCK_AI_FAILURE_RATE,
    }),
});
