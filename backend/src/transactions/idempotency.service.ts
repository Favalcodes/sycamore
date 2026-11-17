import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** An in-progress key older than this is assumed abandoned (crashed request). */
const STALE_AFTER_MS = 5 * 60_000;

export interface StoredResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

/**
 * Idempotency-Key support (Stripe-style) for import endpoints.
 *
 * The natural key (account + externalReference) already prevents duplicate
 * rows. This layer adds exact response replay: a client that times out and
 * retries gets the original result, and two concurrent requests with the same
 * key cannot both run (the second gets 409 while the first is in flight).
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  static hashRequest(method: string, path: string, body: unknown): string {
    return createHash('sha256')
      .update(`${method}\n${path}\n${JSON.stringify(body ?? null)}`)
      .digest('hex');
  }

  async run(
    organisationId: string,
    key: string,
    requestHash: string,
    handler: () => Promise<{ status: number; body: unknown }>,
  ): Promise<StoredResponse> {
    const db = this.prisma.forTenant(organisationId);

    try {
      await db.idempotencyKey.create({
        data: { organisationId, key, requestHash },
      });
    } catch (error) {
      if (!(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ))
        throw error;

      const existing = await db.idempotencyKey.findUnique({
        where: { organisationId_key: { organisationId, key } },
      });
      if (!existing)
        throw new ConflictException(
          'Idempotency key is being released; retry shortly',
        );
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException(
          'This Idempotency-Key was already used with a different request body. Use a new key for a new request.',
        );
      }
      if (existing.status === 'COMPLETED') {
        return {
          status: existing.responseStatus ?? 200,
          body: existing.responseBody,
          replayed: true,
        };
      }
      const stale = Date.now() - existing.updatedAt.getTime() > STALE_AFTER_MS;
      if (!stale) {
        throw new ConflictException(
          'A request with this Idempotency-Key is still being processed',
        );
      }
      // Take over an abandoned key. The conditional update means only one retry wins.
      const claimed = await db.idempotencyKey.updateMany({
        where: { key, status: 'IN_PROGRESS', updatedAt: existing.updatedAt },
        data: { updatedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException(
          'A request with this Idempotency-Key is still being processed',
        );
      }
    }

    try {
      const result = await handler();
      await db.idempotencyKey.update({
        where: { organisationId_key: { organisationId, key } },
        data: {
          status: 'COMPLETED',
          responseStatus: result.status,
          responseBody: result.body as Prisma.InputJsonValue,
        },
      });
      return { ...result, replayed: false };
    } catch (error) {
      // Failed requests are not cached: release the key so the client can retry.
      await db.idempotencyKey
        .deleteMany({ where: { key, status: 'IN_PROGRESS' } })
        .catch(() => undefined);
      throw error;
    }
  }
}
