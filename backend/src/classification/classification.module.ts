import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ClassificationService } from './classification.service.js';
import { CLASSIFICATION_PROVIDER, ClassificationProvider } from './provider.js';
import { createClassificationProvider } from './providers/registry.js';

/**
 * Binds CLASSIFICATION_PROVIDER to the provider chosen by AI_PROVIDER.
 * Nothing outside `providers/` knows which model is in use; adding one is a
 * new provider file plus one line in the registry — this module never changes.
 */
@Module({
  providers: [
    {
      provide: CLASSIFICATION_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ClassificationProvider =>
        createClassificationProvider(process.env, {
          timeoutMs: config.get('AI_TIMEOUT_MS', { infer: true }),
        }),
    },
    ClassificationService,
  ],
  exports: [ClassificationService],
})
export class ClassificationModule {}
