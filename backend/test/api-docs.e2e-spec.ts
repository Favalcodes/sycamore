import { createHarness, Harness } from './harness.js';

describe('API documentation (Swagger)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('serves Swagger UI without authentication', async () => {
    const res = await h.http().get('/api/docs').expect(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('documents every route, generated from the same Zod schemas used for validation', async () => {
    const { body: doc } = await h.http().get('/api/docs-json').expect(200);
    const routes = Object.entries(
      doc.paths as Record<string, Record<string, unknown>>,
    ).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        'POST /api/auth/login',
        'GET /api/auth/me',
        'GET /api/accounts',
        'POST /api/transactions',
        'POST /api/transactions/batch',
        'GET /api/transactions',
        'GET /api/transactions/{id}',
        'PATCH /api/transactions/{id}/category',
        'GET /api/review/flags',
        'GET /api/review/summary',
        'PATCH /api/review/flags/{id}',
        'GET /api/dashboard',
        'GET /api/health',
      ]),
    );

    // Query params come from listTransactionsQuerySchema.
    const listParams = doc.paths['/api/transactions'].get.parameters.map(
      (p: { name: string }) => p.name,
    );
    expect(listParams).toEqual(
      expect.arrayContaining([
        'q',
        'cursor',
        'category',
        'minAmount',
        'flagged',
      ]),
    );

    // Money is documented as a decimal string with its exact pattern.
    const amount =
      doc.paths['/api/transactions/batch'].post.requestBody.content[
        'application/json'
      ].schema.properties.transactions.items.properties.amount;
    expect(amount).toMatchObject({
      type: 'string',
      pattern: expect.stringContaining('\\d{1,2}'),
    });

    // Protected routes require the bearer token; login does not.
    expect(doc.paths['/api/transactions'].get.security).toEqual([
      { bearer: [] },
    ]);
    expect(doc.paths['/api/auth/login'].post.security).toBeUndefined();
  });
});
