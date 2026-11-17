import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const DOCS_PATH = 'api/docs';

/**
 * Swagger UI at /api/docs, OpenAPI JSON at /api/docs-json.
 *
 * Request bodies, query strings and path params come straight from the Zod
 * schemas the endpoints validate with (Zod implements Standard JSON Schema),
 * so the documentation cannot drift from what the API actually accepts.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Transaction Intelligence API')
    .setDescription(
      [
        'Multi-tenant API for importing, categorising and reviewing NGN business transactions.',
        '',
        '**Authentication** — call `POST /api/auth/login`, then click **Authorize** and paste the `accessToken`. ' +
          'The organisation you act for comes from the token; ids from other organisations return 404.',
        '',
        '**Money** — always strings. Send `"amount": "12999.75"` (JSON numbers are rejected); responses return ' +
          '`{ minor: "1299975", value: "12999.75", currency: "NGN" }` where `minor` is integer kobo.',
        '',
        '**Errors** — `{ statusCode, error, message, requestId }`; `requestId` matches the `X-Request-Id` header.',
        '',
        '**Pagination** — keyset: pass `pageInfo.nextCursor` back as `cursor`.',
        '',
        'Demo login: `amaka@ofada.test` / `Password123!`.',
      ].join('\n'),
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .addTag('Auth', 'Sign in and current user')
    .addTag('Accounts', "The organisation's bank accounts")
    .addTag('Transactions', 'Import, browse and correct transactions')
    .addTag('Review', 'Flags that need a person to look at them')
    .addTag('Dashboard', 'Cash flow, spending and flags for a period')
    .addTag('Health', 'Liveness, database and classification pipeline status')
    .build();

  SwaggerModule.setup(
    DOCS_PATH,
    app,
    () =>
      SwaggerModule.createDocument(app, config, { autoTagControllers: false }),
    {
      jsonDocumentUrl: `${DOCS_PATH}-json`,
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        tagsSorter: 'alpha',
      },
      customSiteTitle: 'Transaction Intelligence API',
    },
  );
}
