import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { IdempotencyService } from './idempotency.service.js';
import {
  batchImportSchema,
  correctCategorySchema,
  listTransactionsQuerySchema,
  uuidParam,
} from './transaction.schemas.js';
import type {
  CorrectCategoryInput,
  ListTransactionsQuery,
} from './transaction.schemas.js';
import { TransactionsService } from './transactions.service.js';

const idempotencyKeySchema = z.string().trim().min(8).max(200).optional();

@Controller()
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('accounts')
  listAccounts(@CurrentUser() user: AuthUser) {
    return this.transactions.listAccounts(user.organisationId);
  }

  /**
   * Import one transaction.
   * 201 created · 200 already imported (idempotent replay) · 400 invalid ·
   * 404 unknown account · 409 reference reused with different details.
   */
  @Post('transactions')
  async importOne(
    @CurrentUser() user: AuthUser,
    @Body() body: unknown,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withIdempotency(user, rawKey, req, res, async () => {
      const result = await this.transactions.importTransactions(user, [body]);
      const item = result.results[0];
      switch (item.status) {
        case 'created':
          return {
            status: 201,
            body: {
              duplicate: false,
              transaction: await this.transactions.getById(
                user.organisationId,
                item.transactionId!,
              ),
            },
          };
        case 'duplicate':
          return {
            status: 200,
            body: {
              duplicate: true,
              transaction: await this.transactions.getById(
                user.organisationId,
                item.transactionId!,
              ),
            },
          };
        default:
          if (item.code === 'ACCOUNT_NOT_FOUND')
            throw new NotFoundException({
              message: item.errors,
              code: item.code,
            });
          if (item.code === 'REFERENCE_CONFLICT')
            throw new ConflictException({
              message: item.errors,
              code: item.code,
            });
          if (item.code === 'CURRENCY_MISMATCH')
            throw new UnprocessableEntityException({
              message: item.errors,
              code: item.code,
            });
          throw new BadRequestException({
            message: item.errors,
            code: item.code,
          });
      }
    });
  }

  /**
   * Import up to 1000 transactions. Always 200 when the envelope is valid;
   * each item reports created / duplicate / rejected with reasons.
   */
  @Post('transactions/batch')
  importBatch(
    @CurrentUser() user: AuthUser,
    @Body({ schema: batchImportSchema })
    body: z.infer<typeof batchImportSchema>,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.withIdempotency(user, rawKey, req, res, async () => ({
      status: 200,
      body: await this.transactions.importTransactions(user, body.transactions),
    }));
  }

  @Get('transactions')
  list(
    @CurrentUser() user: AuthUser,
    @Query({ schema: listTransactionsQuerySchema })
    query: ListTransactionsQuery,
  ) {
    return this.transactions.list(user.organisationId, query);
  }

  @Get('transactions/:id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.transactions.getById(user.organisationId, id);
  }

  @Patch('transactions/:id/category')
  correct(
    @CurrentUser() user: AuthUser,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: correctCategorySchema }) body: CorrectCategoryInput,
  ) {
    return this.transactions.correctCategory(user, id, body);
  }

  private async withIdempotency(
    user: AuthUser,
    rawKey: string | undefined,
    req: Request,
    res: Response,
    handler: () => Promise<{ status: number; body: unknown }>,
  ) {
    const parsedKey = idempotencyKeySchema.safeParse(rawKey);
    if (!parsedKey.success) {
      throw new BadRequestException('Idempotency-Key must be 8-200 characters');
    }
    const key = parsedKey.data;

    const result = key
      ? await this.idempotency.run(
          user.organisationId,
          key,
          IdempotencyService.hashRequest(req.method, req.path, req.body),
          handler,
        )
      : { ...(await handler()), replayed: false };

    res.status(result.status);
    if (key) res.setHeader('Idempotent-Replayed', String(result.replayed));
    return result.body;
  }
}
