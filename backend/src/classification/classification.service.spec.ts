import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ClassificationService } from './classification.service.js';
import {
  ClassificationInput,
  ClassificationProvider,
  ClassificationResult,
  ProviderError,
} from './provider.js';

function config(overrides: Partial<Env> = {}) {
  const values: Partial<Env> = {
    CIRCUIT_FAILURE_THRESHOLD: 2,
    CIRCUIT_OPEN_MS: 60_000,
    AI_MAX_REQUESTS_PER_MINUTE: 100,
    AI_BATCH_SIZE: 10,
    AI_TIMEOUT_MS: 1_000,
    RULES_ACCEPT_CONFIDENCE: 0.9,
    ...overrides,
  };
  return { get: (key: keyof Env) => values[key] } as unknown as ConfigService<
    Env,
    true
  >;
}

class FakeProvider implements ClassificationProvider {
  readonly name = 'fake';
  calls = 0;
  behaviour: (
    inputs: ClassificationInput[],
  ) => Promise<ClassificationResult[]> = async (inputs) =>
    inputs.map((i) => ({
      id: i.id,
      category: 'OTHER',
      confidence: 0.8,
      rationale: 'fake',
    }));

  classify(inputs: ClassificationInput[]) {
    this.calls += 1;
    return this.behaviour(inputs);
  }
}

const tx = (
  id: string,
  description: string,
  direction: 'CREDIT' | 'DEBIT' = 'DEBIT',
): ClassificationInput => ({
  id,
  description,
  merchant: null,
  direction,
  amount: '1000.00',
  currency: 'NGN',
});

describe('ClassificationService', () => {
  let provider: FakeProvider;
  let service: ClassificationService;

  beforeEach(() => {
    provider = new FakeProvider();
    service = new ClassificationService(provider, config());
  });

  it('answers confident rule matches without calling the AI', async () => {
    const out = await service.classify([
      tx('a', 'SMS ALERT CHARGES'),
      tx('b', 'LIRS PAYE REMITTANCE'),
    ]);
    expect(provider.calls).toBe(0);
    expect(out.get('a')).toMatchObject({
      kind: 'classified',
      source: 'RULES',
      result: { category: 'BANK_FEES' },
    });
    expect(out.get('b')).toMatchObject({
      kind: 'classified',
      source: 'RULES',
      result: { category: 'TAX' },
    });
  });

  it('sends only ambiguous transactions to the AI', async () => {
    const out = await service.classify([
      tx('a', 'SMS ALERT CHARGES'),
      tx('b', 'TRF TO K. OKONKWO'),
    ]);
    expect(provider.calls).toBe(1);
    expect(out.get('b')).toMatchObject({
      kind: 'classified',
      source: 'AI',
      provider: 'fake',
    });
  });

  it('defers without using an attempt when the provider times out (outage, not the item)', async () => {
    provider.behaviour = async () => {
      throw new ProviderError('TIMEOUT', 'too slow');
    };
    const out = await service.classify([tx('a', 'TRF TO K. OKONKWO')]);
    expect(out.get('a')).toMatchObject({
      kind: 'deferred',
      consumesAttempt: false,
    });
    expect(service.breaker.snapshot().consecutiveFailures).toBe(1);
  });

  it('counts an attempt when the model answers with something unusable', async () => {
    provider.behaviour = async () => {
      throw new ProviderError('INVALID_RESPONSE', 'not JSON');
    };
    const out = await service.classify([tx('a', 'TRF TO K. OKONKWO')]);
    expect(out.get('a')).toMatchObject({
      kind: 'deferred',
      consumesAttempt: true,
    });
  });

  it('keeps the rule guess as a fallback when deferring', async () => {
    provider.behaviour = async () => {
      throw new ProviderError('UNAVAILABLE', 'down');
    };
    const out = await service.classify([
      tx('a', 'TRF FROM CHIDI NWOSU', 'CREDIT'),
    ]);
    const outcome = out.get('a');
    expect(outcome?.kind).toBe('deferred');
    if (outcome?.kind === 'deferred')
      expect(outcome.fallback?.category).toBe('REVENUE');
  });

  it('treats a 429 as "wait", not as a failure: no attempt used, circuit stays closed', async () => {
    provider.behaviour = async () => {
      throw new ProviderError('RATE_LIMITED', 'slow down', 15_000);
    };
    const out = await service.classify([tx('a', 'TRF TO K. OKONKWO')]);
    expect(out.get('a')).toMatchObject({
      kind: 'deferred',
      consumesAttempt: false,
      retryAfterMs: 15_000,
    });
    expect(service.breaker.snapshot().state).toBe('CLOSED');
    expect(service.limiter.waitMs()).toBeGreaterThan(14_000);
  });

  it('opens the circuit after repeated failures and stops calling the provider', async () => {
    provider.behaviour = async () => {
      throw new ProviderError('UNAVAILABLE', 'HTTP 503');
    };
    await service.classify([tx('a', 'TRF TO A')]);
    await service.classify([tx('b', 'TRF TO B')]);
    expect(provider.calls).toBe(2);
    expect(service.breaker.snapshot().state).toBe('OPEN');

    const out = await service.classify([tx('c', 'TRF TO C')]);
    expect(provider.calls).toBe(2); // not called again
    // Waiting on an open circuit must not burn the transaction's attempts.
    expect(out.get('c')).toMatchObject({
      kind: 'deferred',
      consumesAttempt: false,
    });
  });

  it('keeps valid items and retries only the ones the model got wrong', async () => {
    provider.behaviour = async (inputs) => [
      {
        id: inputs[0].id,
        category: 'MARKETING',
        confidence: 0.9,
        rationale: 'ok',
      },
      // second input omitted (e.g. dropped by validation)
    ];
    const out = await service.classify([
      tx('a', 'TRF TO A'),
      tx('b', 'TRF TO B'),
    ]);
    expect(out.get('a')).toMatchObject({
      kind: 'classified',
      result: { category: 'MARKETING' },
    });
    expect(out.get('b')).toMatchObject({
      kind: 'deferred',
      consumesAttempt: true,
    });
  });

  it('treats unexpected exceptions as provider unavailability, never crashing the batch', async () => {
    provider.behaviour = async () => {
      throw new TypeError('fetch failed');
    };
    const out = await service.classify([tx('a', 'TRF TO A')]);
    expect(out.get('a')).toMatchObject({
      kind: 'deferred',
      consumesAttempt: false,
    });
  });

  it('chunks large batches by AI_BATCH_SIZE', async () => {
    service = new ClassificationService(provider, config({ AI_BATCH_SIZE: 3 }));
    await service.classify(
      Array.from({ length: 7 }, (_, i) => tx(`t${i}`, `TRF TO PERSON ${i}`)),
    );
    expect(provider.calls).toBe(3);
  });
});
