import { z } from 'zod';
import type { ClassificationProvider } from '../provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { MockAiProvider } from './mock-ai.provider.js';
import { defineProvider } from './provider-definition.js';
import {
  createClassificationProvider,
  PROVIDERS,
  ProviderConfigError,
} from './registry.js';

const shared = { timeoutMs: 1_000 };

describe('provider registry', () => {
  it('uses Gemini automatically when its key is set', () => {
    const provider = createClassificationProvider(
      { GEMINI_API_KEY: 'key' },
      shared,
    );
    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.name).toBe('gemini:gemini-3.5-flash-lite');
  });

  it('falls back to the mock when no real model is configured', () => {
    expect(createClassificationProvider({}, shared)).toBeInstanceOf(
      MockAiProvider,
    );
  });

  it('honours AI_PROVIDER, case-insensitively, over auto-selection', () => {
    expect(
      createClassificationProvider(
        { AI_PROVIDER: 'MOCK', GEMINI_API_KEY: 'key' },
        shared,
      ),
    ).toBeInstanceOf(MockAiProvider);
    const custom = createClassificationProvider(
      { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-x' },
      shared,
    );
    expect(custom.name).toBe('gemini:gemini-x');
  });

  it('fails at boot for an unknown provider, listing the available ones', () => {
    expect(() =>
      createClassificationProvider({ AI_PROVIDER: 'gpt' }, shared),
    ).toThrow(/Unknown AI_PROVIDER "gpt"\. Available providers: gemini, mock/);
  });

  it("fails at boot when the chosen provider's own settings are invalid", () => {
    expect(() =>
      createClassificationProvider({ AI_PROVIDER: 'gemini' }, shared),
    ).toThrow(ProviderConfigError);
    expect(() =>
      createClassificationProvider({ AI_PROVIDER: 'gemini' }, shared),
    ).toThrow(/GEMINI_API_KEY/);
    expect(() =>
      createClassificationProvider(
        { AI_PROVIDER: 'mock', MOCK_AI_FAILURE_RATE: '2' },
        shared,
      ),
    ).toThrow(/MOCK_AI_FAILURE_RATE/);
  });

  it('has unique ids', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accepts a new provider without changes anywhere else', () => {
    const fake: ClassificationProvider = {
      name: 'acme:large',
      classify: async () => [],
    };
    const acme = defineProvider({
      id: 'acme',
      description: 'Example vendor',
      configSchema: z.object({ ACME_API_KEY: z.string().min(1) }),
      isConfigured: (env) => Boolean(env.ACME_API_KEY),
      create: () => fake,
    });
    const provider = createClassificationProvider(
      { ACME_API_KEY: 'k' },
      shared,
      [acme, ...PROVIDERS],
    );
    expect(provider).toBe(fake);
  });
});
