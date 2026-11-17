import { Logger } from '@nestjs/common';
import type { ClassificationProvider } from '../provider.js';
import { geminiProvider } from './gemini.provider.js';
import { mockAiProvider } from './mock-ai.provider.js';
import type {
  ProviderDefinition,
  RawEnv,
  SharedProviderOptions,
} from './provider-definition.js';

/**
 * Every classification provider the app can use.
 *
 * To add an LLM: create `<name>.provider.ts` with a class extending
 * LlmProvider and a `defineProvider({...})` export, then add it here.
 * Order matters only for auto-selection: when AI_PROVIDER is unset, the first
 * configured provider wins, so real models come before the mock.
 */
export const PROVIDERS: ReadonlyArray<ProviderDefinition<any>> = [
  geminiProvider,
  mockAiProvider,
];

export class ProviderConfigError extends Error {}

/** Picks the provider named by AI_PROVIDER (or the first configured one) and builds it. */
export function createClassificationProvider(
  env: RawEnv,
  shared: SharedProviderOptions,
  providers: ReadonlyArray<ProviderDefinition<any>> = PROVIDERS,
): ClassificationProvider {
  const requested = env.AI_PROVIDER?.trim().toLowerCase();
  const available = providers.map((p) => p.id).join(', ');

  const definition = requested
    ? providers.find((p) => p.id === requested)
    : providers.find((p) => p.isConfigured(env));
  if (!definition) {
    throw new ProviderConfigError(
      requested
        ? `Unknown AI_PROVIDER "${requested}". Available providers: ${available}`
        : `No classification provider is configured. Available providers: ${available}`,
    );
  }

  const parsed = definition.configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || definition.id}: ${i.message}`,
    );
    throw new ProviderConfigError(
      `Invalid configuration for the "${definition.id}" provider:\n${problems.join('\n')}`,
    );
  }

  const provider = definition.create(parsed.data, shared);
  new Logger('ClassificationProvider').log(
    `Using ${provider.name} — ${definition.description}${requested ? '' : ' (auto-selected; set AI_PROVIDER to choose)'}`,
  );
  return provider;
}
