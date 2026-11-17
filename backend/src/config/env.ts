import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/**
 * Every environment variable the app reads, validated once at boot.
 * A misconfigured deployment fails fast instead of misbehaving later.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Connection pool size for the app's pg pool. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 60 * 60),

  // --- Classification ------------------------------------------------------
  /**
   * Which provider classifies transactions (see classification/providers/registry.ts).
   * Unset: the first configured provider is used (Gemini when GEMINI_API_KEY is
   * set, otherwise the mock). Each provider validates its own settings at boot.
   */
  AI_PROVIDER: z.string().trim().toLowerCase().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Requests per minute we allow ourselves to send (free tier is tight). */
  AI_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Transactions sent to the model in one request. */
  AI_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(20),
  /** Rule matches at or above this confidence skip the model entirely. */
  RULES_ACCEPT_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  /** Automated decisions below this confidence are flagged for review. */
  LOW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  CLASSIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_OPEN_MS: z.coerce.number().int().positive().default(60_000),

  // --- Background processing ----------------------------------------------
  WORKER_ENABLED: bool.default(true),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(2_000),

  // --- Review detection ----------------------------------------------------
  /** Any single transaction at or above this (major units, NGN) is flagged. */
  LARGE_AMOUNT_ABSOLUTE_NGN: z.coerce
    .number()
    .int()
    .positive()
    .default(25_000_000),
  /** Flag when an amount exceeds the largest prior one on the account by this factor. */
  LARGE_AMOUNT_MULTIPLIER: z.coerce.number().positive().default(2.5),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
