import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators.js';
import { ClassificationService } from '../classification/classification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Liveness/readiness plus the operational signals that matter during an AI
 * outage: circuit state and queue depth. Aggregate counts only — no tenant data.
 */
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly classification: ClassificationService,
  ) {}

  @Public()
  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'down',
      });
    }

    const queue = await this.prisma.$queryRaw<
      Array<{ status: string; n: number; oldest: Date | null }>
    >`
      SELECT classification_status::text AS status, count(*)::int AS n, min(created_at) AS oldest
      FROM transactions
      WHERE classification_status IN ('PENDING', 'PROCESSING', 'FAILED')
      GROUP BY classification_status
    `;
    const pending = queue.find((q) => q.status === 'PENDING');

    return {
      status: 'ok',
      database: 'up',
      classification: {
        ...this.classification.health(),
        queue: Object.fromEntries(queue.map((q) => [q.status, q.n])),
        oldestPendingAgeSeconds: pending?.oldest
          ? Math.round((Date.now() - pending.oldest.getTime()) / 1000)
          : 0,
      },
    };
  }
}
