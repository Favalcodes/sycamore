import type { z } from 'zod';
import type { ClassificationProvider } from '../provider.js';

export type RawEnv = Record<string, string | undefined>;

/** Settings every provider receives, regardless of vendor. */
export interface SharedProviderOptions {
  /** Hard deadline for one classification request. */
  timeoutMs: number;
}

/**
 * Everything the app needs to know about one classification provider.
 * Each provider file exports one of these; the registry lists them.
 *
 * A provider owns its configuration: its env vars are declared and validated
 * here, not in the global env schema, so adding a provider never touches
 * shared files beyond one line in the registry.
 */
export interface ProviderDefinition<Config = unknown> {
  /** Value of AI_PROVIDER that selects this provider, e.g. "gemini". */
  id: string;
  /** One line shown in logs and errors. */
  description: string;
  /** Validates and types this provider's env vars (e.g. API key, model). */
  configSchema: z.ZodType<Config>;
  /**
   * Whether enough configuration is present to use this provider without it
   * being named in AI_PROVIDER (typically: its API key is set).
   */
  isConfigured(env: RawEnv): boolean;
  create(config: Config, shared: SharedProviderOptions): ClassificationProvider;
}

/** Helper that keeps `Config` inferred from the schema. */
export function defineProvider<Config>(
  definition: ProviderDefinition<Config>,
): ProviderDefinition<Config> {
  return definition;
}
