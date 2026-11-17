import { StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { setupSwagger } from './swagger.js';

/** HTTP pipeline shared by main.ts and the e2e tests, so tests exercise the real thing. */
export function configureApp(
  app: NestExpressApplication,
): NestExpressApplication {
  // Batches of up to 1000 transactions exceed Express's 100kb default.
  app.useBodyParser('json', { limit: '2mb' });
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim()),
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
  });
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.setGlobalPrefix('api');
  setupSwagger(app);
  return app;
}
