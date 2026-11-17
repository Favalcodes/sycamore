import { ApiError, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { ProviderError } from '../provider.js';
import {
  LlmProvider,
  LlmRequest,
  providerErrorFromStatus,
} from './llm-provider.js';
import { defineProvider } from './provider-definition.js';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** The part of the SDK we use; injectable so tests can stand in for Google. */
export type GeminiClient = Pick<GoogleGenAI, 'models'>;

/**
 * Google Gemini via the official SDK. The SDK's own retries are disabled:
 * retrying is the job queue's responsibility (durable, backed off, visible),
 * not a hidden loop inside one HTTP call.
 */
export class GeminiProvider extends LlmProvider {
  readonly name: string;
  private readonly client: GeminiClient;

  constructor(
    private readonly options: GeminiOptions,
    client?: GeminiClient,
  ) {
    super(options.timeoutMs);
    this.name = `gemini:${options.model}`;
    this.client =
      client ??
      new GoogleGenAI({
        apiKey: options.apiKey,
        httpOptions: {
          timeout: options.timeoutMs,
          retryOptions: { attempts: 1 },
        },
      });
  }

  protected async complete(request: LlmRequest): Promise<string | undefined> {
    const response = await this.client.models.generateContent({
      model: this.options.model,
      contents: request.prompt,
      config: {
        systemInstruction: request.system,
        responseMimeType: 'application/json',
        responseJsonSchema: request.jsonSchema,
        temperature: 0,
        abortSignal: request.signal,
      },
    });
    return response.text;
  }

  protected mapError(error: unknown, signal: AbortSignal): ProviderError {
    if (error instanceof ApiError) {
      return providerErrorFromStatus(
        this.name,
        error.status,
        parseRetryDelay(error.message),
      );
    }
    return super.mapError(error, signal);
  }
}

/** Gemini's 429 body includes e.g. "retryDelay": "23s". */
export function parseRetryDelay(message: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}

export const geminiProvider = defineProvider({
  id: 'gemini',
  description: 'Google Gemini (free tier available)',
  configSchema: z.object({
    GEMINI_API_KEY: z
      .string({ error: 'GEMINI_API_KEY is required for the gemini provider' })
      .trim()
      .min(1),
    GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash-lite'),
  }),
  isConfigured: (env) => Boolean(env.GEMINI_API_KEY?.trim()),
  create: (config, shared) =>
    new GeminiProvider({
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL,
      timeoutMs: shared.timeoutMs,
    }),
});
