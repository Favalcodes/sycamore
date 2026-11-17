import { createHarness, Harness, TestOrg, txPayload } from './harness.js';

describe('Tenant isolation', () => {
  let h: Harness;
  let a: TestOrg;
  let b: TestOrg;
  let aTxId: string;

  beforeAll(async () => {
    h = await createHarness();
    a = await h.createOrg('alpha');
    b = await h.createOrg('beta');
    const res = await h
      .http()
      .post('/api/transactions')
      .set('Authorization', `Bearer ${a.token}`)
      .send(
        txPayload(a.accountId, {
          description: 'ALPHA CONFIDENTIAL PAYMENT',
          amount: '30000000.00',
        }),
      )
      .expect(201);
    aTxId = res.body.transaction.id;
    await h.worker.tick();
  });

  afterAll(() => h.close());

  const as = (org: TestOrg) => ({ Authorization: `Bearer ${org.token}` });

  it('rejects requests without a valid token', async () => {
    await h.http().get('/api/transactions').expect(401);
    await h
      .http()
      .get('/api/transactions')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it("returns 404 (not 403) for another organisation's transaction", async () => {
    await h.http().get(`/api/transactions/${aTxId}`).set(as(b)).expect(404);
    await h.http().get(`/api/transactions/${aTxId}`).set(as(a)).expect(200);
  });

  it("never lists or searches another organisation's data", async () => {
    const list = await h
      .http()
      .get('/api/transactions?q=ALPHA%20CONFIDENTIAL')
      .set(as(b))
      .expect(200);
    expect(list.body.data).toHaveLength(0);
    const own = await h
      .http()
      .get('/api/transactions?q=ALPHA%20CONFIDENTIAL')
      .set(as(a))
      .expect(200);
    expect(own.body.data).toHaveLength(1);
  });

  it("cannot correct another organisation's transaction", async () => {
    await h
      .http()
      .patch(`/api/transactions/${aTxId}/category`)
      .set(as(b))
      .send({ category: 'RENT' })
      .expect(404);
    const events = await h.prisma.classificationEvent.count({
      where: { transactionId: aTxId, source: 'MANUAL' },
    });
    expect(events).toBe(0);
  });

  it("cannot import into another organisation's account", async () => {
    const res = await h
      .http()
      .post('/api/transactions/batch')
      .set(as(b))
      .send({ transactions: [txPayload(a.accountId)] })
      .expect(200);
    expect(res.body.results[0]).toMatchObject({
      status: 'rejected',
      code: 'ACCOUNT_NOT_FOUND',
    });
    expect(
      await h.prisma.transaction.count({ where: { organisationId: b.id } }),
    ).toBe(0);
  });

  it("cannot see or resolve another organisation's review flags", async () => {
    const flag = await h.prisma.reviewFlag.findFirst({
      where: { organisationId: a.id },
    });
    expect(flag?.type).toBe('LARGE_AMOUNT'); // ₦30m is above the absolute review threshold
    await h
      .http()
      .patch(`/api/review/flags/${flag!.id}`)
      .set(as(b))
      .send({ status: 'DISMISSED' })
      .expect(404);
    const bFlags = await h
      .http()
      .get('/api/review/flags')
      .set(as(b))
      .expect(200);
    expect(bFlags.body.data).toHaveLength(0);
  });

  it('keeps dashboards separate', async () => {
    const dash = await h.http().get('/api/dashboard').set(as(b)).expect(200);
    expect(dash.body.totals.outflow.minor).toBe('0');
  });

  it('the scoped client refuses to write a row for a different organisation', async () => {
    const scoped = h.prisma.forTenant(b.id);
    await expect(
      scoped.importBatch.create({
        data: { organisationId: a.id, totalCount: 1 },
      }),
    ).rejects.toThrow(/different organisation/);
  });

  it('the database refuses a transaction pointing at another organisation’s account', async () => {
    await expect(
      h.prisma.transaction.create({
        data: {
          organisationId: b.id,
          accountId: a.accountId, // belongs to A
          externalReference: 'CROSS-TENANT',
          amountMinor: 100n,
          currency: 'NGN',
          direction: 'DEBIT',
          description: 'should fail',
          descriptionKey: 'should fail',
          transactionDate: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});
