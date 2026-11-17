import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  CLASSIFICATION_PROVIDER,
  ClassificationInput,
  ClassificationProvider,
  ClassificationResult,
  ProviderError,
} from '../src/classification/provider.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProcessingWorker } from '../src/processing/processing.worker.js';
import { ClassificationService } from '../src/classification/classification.service.js';

/** A provider the tests can switch between healthy, down and rate-limited. */
export class ControllableProvider implements ClassificationProvider {
  readonly name = 'test-ai';
  mode: 'ok' | 'down' | 'rate-limited' | 'garbage' = 'ok';
  calls = 0;
  /** Runs while the "model" is thinking, to simulate concurrent activity. */
  onCall: (() => Promise<void>) | null = null;
  answer: (input: ClassificationInput) => Omit<ClassificationResult, 'id'> =
    () => ({
      category: 'OTHER',
      confidence: 0.85,
      rationale: 'test answer',
    });

  async classify(
    inputs: ClassificationInput[],
  ): Promise<ClassificationResult[]> {
    this.calls += 1;
    if (this.onCall) await this.onCall();
    if (this.mode === 'down')
      throw new ProviderError('UNAVAILABLE', 'HTTP 503 from test provider');
    if (this.mode === 'rate-limited')
      throw new ProviderError('RATE_LIMITED', 'quota', 10_000);
    if (this.mode === 'garbage')
      throw new ProviderError(
        'INVALID_RESPONSE',
        'model returned prose, not JSON',
      );
    return inputs.map((i) => ({ id: i.id, ...this.answer(i) }));
  }
}

export interface TestOrg {
  id: string;
  slug: string;
  email: string;
  password: string;
  accountId: string;
  token: string;
}

export interface Harness {
  app: NestExpressApplication;
  prisma: PrismaService;
  worker: ProcessingWorker;
  classification: ClassificationService;
  provider: ControllableProvider;
  http: () => ReturnType<typeof request>;
  createOrg: (label: string) => Promise<TestOrg>;
  close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const provider = new ControllableProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLASSIFICATION_PROVIDER)
    .useValue(provider)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  const created: string[] = [];
  const http = () => request(app.getHttpServer());

  async function createOrg(label: string): Promise<TestOrg> {
    const suffix = randomUUID().slice(0, 8);
    const slug = `e2e-${label}-${suffix}`;
    const email = `${label}-${suffix}@e2e.test`;
    const password = 'Correct-Horse-9';
    const org = await prisma.organisation.create({
      data: { slug, name: `E2E ${label}` },
    });
    created.push(org.id);
    await prisma.user.create({
      data: {
        organisationId: org.id,
        email,
        name: `${label} user`,
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
    const account = await prisma.account.create({
      data: {
        organisationId: org.id,
        name: 'Main',
        bankName: 'Test Bank',
        accountNumber: suffix,
      },
    });
    const login = await http()
      .post('/api/auth/login')
      .send({ email, password })
      .expect(200);
    return {
      id: org.id,
      slug,
      email,
      password,
      accountId: account.id,
      token: login.body.accessToken,
    };
  }

  async function close() {
    // Remove only what this run created.
    if (created.length) {
      const where = { organisationId: { in: created } };
      await prisma.reviewFlag.deleteMany({ where });
      await prisma.classificationEvent.deleteMany({ where });
      await prisma.transaction.deleteMany({ where });
      await prisma.importBatch.deleteMany({ where });
      await prisma.idempotencyKey.deleteMany({ where });
      await prisma.account.deleteMany({ where });
      await prisma.user.deleteMany({ where });
      await prisma.organisation.deleteMany({ where: { id: { in: created } } });
    }
    await app.close();
  }

  return {
    app,
    prisma,
    worker: app.get(ProcessingWorker),
    classification: app.get(ClassificationService),
    provider,
    http,
    createOrg,
    close,
  };
}

let refCounter = 0;
/** A valid transaction payload with a unique reference. */
export function txPayload(
  accountId: string,
  overrides: Record<string, unknown> = {},
) {
  refCounter += 1;
  return {
    externalReference: `E2E-${Date.now()}-${refCounter}`,
    accountId,
    amount: '12999.75',
    direction: 'DEBIT',
    description: `TRF TO TEST VENDOR ${refCounter}`,
    date: '2026-11-03',
    ...overrides,
  };
}
