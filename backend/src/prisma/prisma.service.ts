import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Env } from '../config/env.js';
import { scopeToTenant } from './tenant-scope.js';
import { connectionHint } from './database-errors.js';

/**
 * The raw client. Only infrastructure (auth lookup, background workers,
 * health checks) should use it directly; request handlers go through
 * `forTenant()`, which cannot read or write another organisation's rows.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly connectionString: string;

  constructor(config: ConfigService<Env, true>) {
    const adapter = new PrismaPg({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      max: config.get('DATABASE_POOL_MAX', { infer: true }),
    });
    super({ adapter });
    this.connectionString = config.get('DATABASE_URL', { infer: true });
  }

  /**
   * Checks the database once at startup and explains a failure in plain
   * words, instead of leaving it to surface as errors on every request.
   * The app keeps running (and /health reports "down") so it recovers by
   * itself once the database becomes reachable.
   */
  async onApplicationBootstrap() {
    try {
      await this.$queryRaw`SELECT 1`;
      this.logger.log(`Connected to database at ${this.describeTarget()}`);
    } catch (error) {
      const hint = connectionHint(this.connectionString);
      this.logger.error(
        `Cannot reach the database at ${this.describeTarget()}: ${(error as Error).message}` +
          (hint ? `\n  Hint: ${hint}` : ''),
      );
    }
  }

  private describeTarget(): string {
    try {
      const url = new URL(this.connectionString);
      return `${url.hostname}:${url.port || '5432'}`;
    } catch {
      return '(invalid DATABASE_URL)';
    }
  }

  /** A client whose every model query is pinned to one organisation. */
  forTenant(organisationId: string) {
    return scopeToTenant(this, organisationId);
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database connections closed');
  }
}

export type TenantClient = ReturnType<PrismaService['forTenant']>;
