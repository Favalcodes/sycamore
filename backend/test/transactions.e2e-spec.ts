import { createHarness, Harness, TestOrg, txPayload } from './harness.js';

describe('Transactions: ingestion, money, pagination, corrections', () => {
  let h: Harness;
  let org: TestOrg;
  const auth = () => ({ Authorization: `Bearer ${org.token}` });

  beforeAll(async () => {
    h = await createHarness();
    org = await h.createOrg('txn');
  });
  afterAll(() => h.close());

  describe('money', () => {
    it('stores ₦12,999.75 exactly and returns it as strings', async () => {
      const res = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(txPayload(org.accountId, { amount: '12999.75' }))
        .expect(201);
      expect(res.body.transaction.amount).toEqual({
        minor: '1299975',
        value: '12999.75',
        currency: 'NGN',
      });

      const [row] = await h.prisma.$queryRaw<Array<{ amount_minor: bigint }>>`
        SELECT amount_minor FROM transactions WHERE id = ${res.body.transaction.id}::uuid`;
      expect(row.amount_minor).toBe(1_299_975n);
    });

    it('aggregates without floating-point error (0.10 + 0.20 = 0.30)', async () => {
      const fresh = await h.createOrg('money');
      await h
        .http()
        .post('/api/transactions/batch')
        .set({ Authorization: `Bearer ${fresh.token}` })
        .send({
          transactions: [
            txPayload(fresh.accountId, {
              amount: '0.10',
              description: 'SMS ALERT CHARGES',
            }),
            txPayload(fresh.accountId, {
              amount: '0.20',
              description: 'SMS ALERT CHARGES',
            }),
          ],
        })
        .expect(200);
      const dash = await h
        .http()
        .get('/api/dashboard')
        .set({ Authorization: `Bearer ${fresh.token}` })
        .expect(200);
      expect(dash.body.totals.outflow.value).toBe('0.30');
    });

    it('rejects a JSON number amount', async () => {
      const res = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(txPayload(org.accountId, { amount: 12999.75 }))
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/decimal string/);
    });
  });

  describe('idempotency and concurrency', () => {
    it('returns the existing transaction when the same one is imported again', async () => {
      const payload = txPayload(org.accountId);
      const first = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(payload)
        .expect(201);
      const again = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(payload)
        .expect(200);
      expect(again.body.duplicate).toBe(true);
      expect(again.body.transaction.id).toBe(first.body.transaction.id);
    });

    it('rejects reuse of a reference with different details', async () => {
      const payload = txPayload(org.accountId);
      await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(payload)
        .expect(201);
      const res = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send({ ...payload, amount: '1.00' })
        .expect(409);
      expect(res.body.code).toBe('REFERENCE_CONFLICT');
    });

    it('stores exactly one row under 25 concurrent identical requests', async () => {
      const payload = txPayload(org.accountId);
      const responses = await Promise.all(
        Array.from({ length: 25 }, () =>
          h.http().post('/api/transactions').set(auth()).send(payload),
        ),
      );
      const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(24);
      expect(new Set(responses.map((r) => r.body.transaction.id)).size).toBe(1);
      expect(
        await h.prisma.transaction.count({
          where: { externalReference: payload.externalReference },
        }),
      ).toBe(1);
    });

    it('stores each transaction once when overlapping batches race', async () => {
      const shared = Array.from({ length: 30 }, () => txPayload(org.accountId));
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          h
            .http()
            .post('/api/transactions/batch')
            .set(auth())
            .send({ transactions: shared }),
        ),
      );
      const created = results.reduce((n, r) => n + r.body.created, 0);
      const duplicates = results.reduce((n, r) => n + r.body.duplicates, 0);
      expect(created).toBe(30);
      expect(duplicates).toBe(120);
    });

    it('replays the stored response for a repeated Idempotency-Key', async () => {
      const key = `key-${Date.now()}-replay`;
      const body = { transactions: [txPayload(org.accountId)] };
      const first = await h
        .http()
        .post('/api/transactions/batch')
        .set(auth())
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);
      expect(first.headers['idempotent-replayed']).toBe('false');
      expect(first.body.created).toBe(1);

      const replay = await h
        .http()
        .post('/api/transactions/batch')
        .set(auth())
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body); // same batchId, same per-item results
    });

    it('refuses an Idempotency-Key reused with a different body', async () => {
      const key = `key-${Date.now()}-mismatch`;
      await h
        .http()
        .post('/api/transactions/batch')
        .set(auth())
        .set('Idempotency-Key', key)
        .send({ transactions: [txPayload(org.accountId)] })
        .expect(200);
      const replay = await h
        .http()
        .post('/api/transactions/batch')
        .set(auth())
        .set('Idempotency-Key', key)
        .send({ transactions: [txPayload(org.accountId)] })
        .expect(422);
      expect(replay.body.message).toMatch(/different request body/);
    });
  });

  describe('partial batch failure', () => {
    it('imports the valid rows and explains each rejected one', async () => {
      const ok = txPayload(org.accountId);
      const res = await h
        .http()
        .post('/api/transactions/batch')
        .set(auth())
        .send({
          transactions: [
            ok,
            { ...txPayload(org.accountId), amount: '-5' },
            { ...txPayload(org.accountId), direction: 'SIDEWAYS' },
            ok,
            {
              ...txPayload(org.accountId),
              accountId: '00000000-0000-4000-8000-000000000000',
            },
            'not even an object',
          ],
        })
        .expect(200);
      expect(res.body).toMatchObject({
        total: 6,
        created: 1,
        duplicates: 0,
        rejected: 5,
      });
      expect(
        res.body.results.map(
          (r: { code?: string; status: string }) => r.code ?? r.status,
        ),
      ).toEqual([
        'created',
        'VALIDATION_FAILED',
        'VALIDATION_FAILED',
        'DUPLICATE_IN_BATCH',
        'ACCOUNT_NOT_FOUND',
        'VALIDATION_FAILED',
      ]);
    });

    it('rejects an empty or oversized batch envelope outright', async () => {
      await h
        .http()
        .post('/api/transactions/batch')
        .set(auth())
        .send({ transactions: [] })
        .expect(400);
      await h
        .http()
        .post('/api/transactions/batch')
        .set(auth())
        .send({ transactions: Array.from({ length: 1001 }, () => ({})) })
        .expect(400);
    });
  });

  describe('listing', () => {
    it('paginates with a stable keyset cursor and no overlap', async () => {
      const fresh = await h.createOrg('pages');
      const transactions = Array.from({ length: 23 }, (_, i) =>
        txPayload(fresh.accountId, {
          date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
        }),
      );
      await h
        .http()
        .post('/api/transactions/batch')
        .set({ Authorization: `Bearer ${fresh.token}` })
        .send({ transactions })
        .expect(200);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: {
          body: {
            data: Array<{ id: string }>;
            pageInfo: { nextCursor: string | null };
          };
        } = await h
          .http()
          .get(`/api/transactions?limit=10${cursor ? `&cursor=${cursor}` : ''}`)
          .set({ Authorization: `Bearer ${fresh.token}` })
          .expect(200);
        seen.push(...res.body.data.map((t: { id: string }) => t.id));
        cursor = res.body.pageInfo.nextCursor;
        pages += 1;
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
    });

    it('filters by direction, amount range and search text', async () => {
      const ref = `FILTER-${Date.now()}`;
      await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(
          txPayload(org.accountId, {
            externalReference: ref,
            direction: 'CREDIT',
            amount: '777777.77',
            description: 'NIP TRF FROM ZEBRA FOODS/INV-1',
          }),
        )
        .expect(201);
      const res = await h
        .http()
        .get(
          '/api/transactions?direction=credit&minAmount=777777.77&maxAmount=777777.77&q=zebra',
        )
        .set(auth())
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].externalReference).toBe(ref);
    });
  });

  describe('manual correction and audit trail', () => {
    it('keeps the original decision, records who changed it, and resolves category flags', async () => {
      h.provider.answer = () => ({
        category: 'MARKETING',
        confidence: 0.4,
        rationale: 'unsure',
      });
      const created = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(
          txPayload(org.accountId, { description: 'PAYMENT TO OLA AND SONS' }),
        )
        .expect(201);
      const id = created.body.transaction.id;
      await h.worker.tick();
      h.provider.answer = () => ({
        category: 'OTHER',
        confidence: 0.85,
        rationale: 'test answer',
      });

      const before = await h
        .http()
        .get(`/api/transactions/${id}`)
        .set(auth())
        .expect(200);
      expect(before.body.category).toBe('MARKETING');
      expect(before.body.flags.map((f: { type: string }) => f.type)).toContain(
        'LOW_CONFIDENCE',
      );

      const corrected = await h
        .http()
        .patch(`/api/transactions/${id}/category`)
        .set(auth())
        .send({
          category: 'RENT',
          note: 'Monthly shop rent',
          expectedVersion: before.body.version,
        })
        .expect(200);

      expect(corrected.body.category).toBe('RENT');
      expect(corrected.body.categorySource).toBe('MANUAL');
      expect(corrected.body.classification.original).toMatchObject({
        category: 'MARKETING',
        source: 'AI',
        provider: 'test-ai',
      });
      expect(corrected.body.classification.correction).toMatchObject({
        from: 'MARKETING',
        note: 'Monthly shop rent',
        by: { email: org.email },
      });
      expect(
        corrected.body.classification.history.map(
          (e: { source: string }) => e.source,
        ),
      ).toEqual(['AI', 'MANUAL']);
      expect(
        corrected.body.flags.find(
          (f: { type: string }) => f.type === 'LOW_CONFIDENCE',
        ).status,
      ).toBe('RESOLVED');

      // A stale editor is told to reload instead of silently overwriting.
      await h
        .http()
        .patch(`/api/transactions/${id}/category`)
        .set(auth())
        .send({ category: 'TAX', expectedVersion: before.body.version })
        .expect(409);
    });

    it('applies a human correction to future transactions with the same description', async () => {
      const description = `TRF TO MAMA CHIOMA CATERING ${Date.now()}`.replace(
        /\d+$/,
        'X',
      );
      const first = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(txPayload(org.accountId, { description }))
        .expect(201);
      await h.worker.tick();
      await h
        .http()
        .patch(`/api/transactions/${first.body.transaction.id}/category`)
        .set(auth())
        .send({ category: 'PAYROLL' })
        .expect(200);

      const callsBefore = h.provider.calls;
      const second = await h
        .http()
        .post('/api/transactions')
        .set(auth())
        .send(txPayload(org.accountId, { description }))
        .expect(201);
      expect(second.body.transaction).toMatchObject({
        category: 'PAYROLL',
        categorySource: 'LEARNED',
      });
      expect(h.provider.calls).toBe(callsBefore);
    });
  });
});
