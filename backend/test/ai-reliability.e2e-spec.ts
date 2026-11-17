import { createHarness, Harness, TestOrg, txPayload } from './harness.js';

describe('AI reliability', () => {
  let h: Harness;
  let org: TestOrg;
  const auth = () => ({ Authorization: `Bearer ${org.token}` });

  beforeAll(async () => {
    h = await createHarness();
    org = await h.createOrg('ai');
  });
  afterAll(() => h.close());

  async function drain() {
    // Make queued rows due now so the test does not wait for real backoff.
    await h.prisma.transaction.updateMany({
      where: { organisationId: org.id, classificationStatus: 'PENDING' },
      data: { nextClassificationAt: new Date(0) },
    });
    await h.worker.tick();
  }

  it('keeps ingesting while the provider is down, then catches up after recovery', async () => {
    h.provider.mode = 'down';

    const transactions = Array.from({ length: 12 }, (_, i) =>
      txPayload(org.accountId, {
        description: `TRF TO OUTAGE SUPPLIER ${String.fromCharCode(65 + i)}`,
      }),
    );
    const res = await h
      .http()
      .post('/api/transactions/batch')
      .set(auth())
      .send({ transactions })
      .expect(200);
    expect(res.body.created).toBe(12); // ingestion unaffected

    await drain(); // provider fails -> circuit opens
    await drain(); // circuit open -> worker does not even try
    const pending = await h.prisma.transaction.count({
      where: { organisationId: org.id, classificationStatus: 'PENDING' },
    });
    expect(pending).toBe(12);
    expect(h.classification.health().circuit.state).toBe('OPEN');

    const callsWhileOpen = h.provider.calls;
    await drain();
    expect(h.provider.calls).toBe(callsWhileOpen);

    // An outage never uses up a transaction's attempts, however long it lasts.
    const attempts = await h.prisma.transaction.aggregate({
      where: { organisationId: org.id },
      _max: { classificationAttempts: true },
    });
    expect(attempts._max.classificationAttempts).toBe(0);

    // Provider recovers; the half-open probe succeeds and the backlog drains.
    h.provider.mode = 'ok';
    h.classification.breaker.openFor(0);
    await drain();
    await drain();
    const classified = await h.prisma.transaction.count({
      where: {
        organisationId: org.id,
        classificationStatus: 'CLASSIFIED',
        categorySource: 'AI',
      },
    });
    expect(classified).toBe(12);
  });

  it('confident rule matches are classified at import, even during an outage', async () => {
    h.provider.mode = 'down';
    const res = await h
      .http()
      .post('/api/transactions')
      .set(auth())
      .send(
        txPayload(org.accountId, {
          description: 'LIRS PAYE REMITTANCE OCT 2026',
        }),
      )
      .expect(201);
    expect(res.body.transaction).toMatchObject({
      category: 'TAX',
      categorySource: 'RULES',
      classificationStatus: 'CLASSIFIED',
    });
    h.provider.mode = 'ok';
  });

  it('falls back and flags for review after exhausting attempts', async () => {
    h.classification.breaker.openFor(0);
    h.classification.breaker.onSuccess();
    const created = await h
      .http()
      .post('/api/transactions')
      .set(auth())
      .send(
        txPayload(org.accountId, {
          description: 'TRF FROM UNKNOWN PARTY',
          direction: 'CREDIT',
        }),
      )
      .expect(201);
    const id = created.body.transaction.id;

    // Simulate the row having already failed 4 times; the model answers garbage again.
    await h.prisma.transaction.update({
      where: { id },
      data: { classificationAttempts: 4 },
    });
    h.provider.mode = 'garbage';
    await drain();
    h.provider.mode = 'ok';

    const detail = await h
      .http()
      .get(`/api/transactions/${id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.classificationStatus).toBe('FAILED');
    expect(detail.body.categorySource).toBe('FALLBACK');
    expect(detail.body.category).toBe('REVENUE'); // the weak rule guess, not a blank
    const flag = detail.body.flags.find(
      (f: { type: string }) => f.type === 'CLASSIFICATION_FAILED',
    );
    expect(flag.reason).toMatch(/failed after 5 attempts/);
  });

  it('does not let a late AI answer overwrite a human correction', async () => {
    h.classification.breaker.openFor(0);
    h.classification.breaker.onSuccess();
    const created = await h
      .http()
      .post('/api/transactions')
      .set(auth())
      .send(
        txPayload(org.accountId, { description: 'TRF TO RACE CONDITION LTD' }),
      )
      .expect(201);
    const id = created.body.transaction.id;

    // While the worker is waiting on the model, a person corrects the transaction.
    h.provider.onCall = async () => {
      await h
        .http()
        .patch(`/api/transactions/${id}/category`)
        .set(auth())
        .send({ category: 'RENT' })
        .expect(200);
    };
    await drain();
    h.provider.onCall = null;

    const detail = await h
      .http()
      .get(`/api/transactions/${id}`)
      .set(auth())
      .expect(200);
    expect(detail.body.category).toBe('RENT');
    expect(detail.body.categorySource).toBe('MANUAL');
  });

  it('flags duplicates and unusually large amounts with explanations', async () => {
    const base = {
      description: 'TRF TO ADEBAYO FARMS LTD INV-88412',
      amount: '4750000.00',
      date: '2026-11-01',
    };
    await h
      .http()
      .post('/api/transactions')
      .set(auth())
      .send(txPayload(org.accountId, base))
      .expect(201);
    const dup = await h
      .http()
      .post('/api/transactions')
      .set(auth())
      .send(
        txPayload(org.accountId, {
          ...base,
          description: 'TRF TO ADEBAYO FARMS LTD/INV-88412',
          date: '2026-11-02',
        }),
      )
      .expect(201);
    const big = await h
      .http()
      .post('/api/transactions')
      .set(auth())
      .send(
        txPayload(org.accountId, {
          amount: '30000000.00',
          description: 'EQUIPMENT PURCHASE',
        }),
      )
      .expect(201);
    await drain();

    const dupDetail = await h
      .http()
      .get(`/api/transactions/${dup.body.transaction.id}`)
      .set(auth())
      .expect(200);
    const dupFlag = dupDetail.body.flags.find(
      (f: { type: string }) => f.type === 'POSSIBLE_DUPLICATE',
    );
    expect(dupFlag.reason).toMatch(
      /Possible duplicate of .*₦4,750,000\.00 debit/,
    );

    const bigDetail = await h
      .http()
      .get(`/api/transactions/${big.body.transaction.id}`)
      .set(auth())
      .expect(200);
    const bigFlag = bigDetail.body.flags.find(
      (f: { type: string }) => f.type === 'LARGE_AMOUNT',
    );
    expect(bigFlag.reason).toMatch(/₦30,000,000\.00 debit is at or above/);
  });
});
