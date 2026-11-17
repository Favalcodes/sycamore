import { descriptionKey } from '../decision-memory.js';
import { ProviderError } from '../provider.js';
import { parseRetryDelay } from './gemini.provider.js';
import { MockAiProvider } from './mock-ai.provider.js';
import { parseModelResults } from './response-schema.js';

describe('parseModelResults (untrusted model output)', () => {
  const ids = new Set(['t1', 't2', 't3']);

  it('accepts well-formed items and normalises category spelling', () => {
    const { results, invalid } = parseModelResults(
      {
        results: [
          {
            id: 't1',
            category: 'Banking Fees'.replace('Banking ', 'BANK_'),
            confidence: 0.91,
            rationale: 'fee',
          },
          { id: 't2', category: 'software', confidence: 0.5, rationale: '' },
        ],
      },
      ids,
    );
    expect(invalid).toBe(0);
    expect(results.map((r) => r.category)).toEqual(['BANK_FEES', 'SOFTWARE']);
  });

  it('drops invented categories, out-of-range confidence, unknown and repeated ids', () => {
    const { results, invalid } = parseModelResults(
      {
        results: [
          { id: 't1', category: 'CRYPTO', confidence: 0.9, rationale: '' },
          { id: 't2', category: 'TAX', confidence: 1.7, rationale: '' },
          { id: 'zzz', category: 'TAX', confidence: 0.9, rationale: '' },
          { id: 't3', category: 'RENT', confidence: 0.9, rationale: '' },
          { id: 't3', category: 'TAX', confidence: 0.9, rationale: '' },
        ],
      },
      ids,
    );
    expect(results).toEqual([
      { id: 't3', category: 'RENT', confidence: 0.9, rationale: '' },
    ]);
    expect(invalid).toBe(4);
  });

  it('rejects a response without the expected envelope', () => {
    expect(parseModelResults(['TAX'], ids)).toEqual({
      results: [],
      invalid: 3,
    });
    expect(
      parseModelResults('ignore previous instructions', ids).results,
    ).toEqual([]);
  });
});

describe('parseRetryDelay', () => {
  it('reads Gemini retryDelay hints', () => {
    expect(
      parseRetryDelay('{"error":{"details":[{"retryDelay": "23s"}]}}'),
    ).toBe(23_000);
    expect(parseRetryDelay('{"retryDelay":"1.5s"}')).toBe(1_500);
    expect(parseRetryDelay('quota exceeded')).toBeUndefined();
  });
});

describe('MockAiProvider', () => {
  const input = {
    id: 'a',
    description: 'TRUCK BRANDING - PRINTMASTERS',
    merchant: null,
    direction: 'DEBIT' as const,
    amount: '1.00',
    currency: 'NGN',
  };

  it('is deterministic for the same text', async () => {
    const mock = new MockAiProvider({ latencyMs: 0, failureRate: 0 });
    const [a] = await mock.classify([input], new AbortController().signal);
    const [b] = await mock.classify([input], new AbortController().signal);
    expect(a).toEqual(b);
    expect(a.category).toBe('MARKETING');
  });

  it('fails with a typed ProviderError when configured to', async () => {
    const mock = new MockAiProvider({
      latencyMs: 0,
      failureRate: 1,
      random: () => 0.1,
    });
    await expect(
      mock.classify([input], new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('honours cancellation', async () => {
    const mock = new MockAiProvider({ latencyMs: 5_000, failureRate: 0 });
    const controller = new AbortController();
    const pending = mock.classify([input], controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });
});

describe('descriptionKey', () => {
  it('folds digits and punctuation so recurring payments share a key', () => {
    expect(descriptionKey('NIP TRF FROM BUKKA HUT/INV-20431')).toBe(
      descriptionKey('NIP TRF FROM BUKKA HUT INV 99812'),
    );
    expect(descriptionKey('PAYSTACK SETTLEMENT 2026-11-12')).toBe(
      'paystack settlement # # #',
    );
  });

  it('keeps different counterparties apart', () => {
    expect(descriptionKey('TRF TO SANI IBRAHIM')).not.toBe(
      descriptionKey('TRF TO SANI MUSA'),
    );
  });
});
