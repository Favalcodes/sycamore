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
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { IdempotencyService } from './idempotency.service.js';
import {
  batchImportSchema,
  correctCategorySchema,
  listTransactionsQuerySchema,
  transactionInputSchema,
  uuidParam,
} from './transaction.schemas.js';
import type {
  CorrectCategoryInput,
  ListTransactionsQuery,
} from './transaction.schemas.js';
import { TransactionsService } from './transactions.service.js';

const idempotencyKeySchema = z.string().trim().min(8).max(200).optional();

/** The import payload as the client sends it (before money/date parsing). */
const transactionInputJsonSchema = z.toJSONSchema(transactionInputSchema, {
  io: 'input',
  unrepresentable: 'any',
}) as Record<string, unknown>;

const transactionExample = {
  externalReference: 'GTB-2026-11-000123',
  accountId: '00000000-0000-4000-8000-000000000000',
  amount: '12999.75',
  currency: 'NGN',
  direction: 'DEBIT',
  description: 'SLACK TECHNOLOGIES SUBSCRIPTION',
  merchant: 'Slack',
  date: '2026-11-03',
};

const IdempotencyKeyHeader = ApiHeader({
  name: 'Idempotency-Key',
  required: false,
  description:
    'Optional, 8–200 chars. Same key + same body replays the stored response (`Idempotent-Replayed: true`); same key + different body → 422; same key while the first request is still running → 409.',
});

@ApiBearerAuth('bearer')
@Controller()
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @ApiTags('Accounts')
  @ApiOperation({ summary: 'List accounts with inflow/outflow totals' })
  @Get('accounts')
  listAccounts(@CurrentUser() user: AuthUser) {
    return this.transactions.listAccounts(user.organisationId);
  }

  /**
   * Import one transaction.
   * 201 created · 200 already imported (idempotent replay) · 400 invalid ·
   * 404 unknown account · 409 reference reused with different details.
   */
  @ApiTags('Transactions')
  @ApiOperation({
    summary: 'Import one transaction',
    description:
      'Idempotent on (accountId, externalReference): re-sending the same transaction returns the existing one with `duplicate: true`. Amount must be a decimal string. Confident keyword-rule matches are categorised immediately; others are queued for AI classification.',
  })
  @ApiBody({
    schema: { ...transactionInputJsonSchema, example: transactionExample },
  })
  @IdempotencyKeyHeader
  @ApiCreatedResponse({
    description: 'Created: `{ duplicate: false, transaction }`',
  })
  @ApiOkResponse({
    description:
      'Already imported with identical details: `{ duplicate: true, transaction }`',
  })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({
    description: 'Unknown account (or another organisation’s)',
  })
  @ApiConflictResponse({
    description:
      'REFERENCE_CONFLICT: reference already used with different details',
  })
  @ApiUnprocessableEntityResponse({
    description: 'CURRENCY_MISMATCH with the account',
  })
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
  @ApiTags('Transactions')
  @ApiOperation({
    summary: 'Import up to 1000 transactions',
    description:
      'Each item is validated on its own and reported as `created`, `duplicate` or `rejected` (with `code` and `errors`), so valid items import even when others fail. Rejection codes: VALIDATION_FAILED, DUPLICATE_IN_BATCH, ACCOUNT_NOT_FOUND, CURRENCY_MISMATCH, REFERENCE_CONFLICT.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['transactions'],
      properties: {
        transactions: {
          type: 'array',
          minItems: 1,
          maxItems: 1000,
          items: transactionInputJsonSchema,
        },
      },
      example: { transactions: [transactionExample] },
    },
  })
  @IdempotencyKeyHeader
  @ApiOkResponse({
    description:
      '`{ batchId, total, created, duplicates, rejected, results[] }`',
  })
  @ApiBadRequestResponse({
    description: 'Envelope invalid (empty or more than 1000 items)',
  })
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

  @ApiTags('Transactions')
  @ApiOperation({
    summary: 'Browse, search and filter transactions',
    description:
      'Newest first, keyset-paginated: pass `pageInfo.nextCursor` as `cursor`. `q` searches description, merchant and reference. `category=UNCATEGORISED` lists transactions awaiting classification. Amount filters are decimal strings.',
  })
  @Get('transactions')
  list(
    @CurrentUser() user: AuthUser,
    @Query({ schema: listTransactionsQuerySchema })
    query: ListTransactionsQuery,
  ) {
    return this.transactions.list(user.organisationId, query);
  }

  @ApiTags('Transactions')
  @ApiOperation({
    summary: 'Transaction detail',
    description:
      'Includes all review flags and the full classification history (original automated decision and any manual correction).',
  })
  @ApiOkResponse({
    description: 'Transaction with flags and classification history',
  })
  @ApiNotFoundResponse({ description: 'Not found in your organisation' })
  @Get('transactions/:id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', { schema: uuidParam }) id: string,
  ) {
    return this.transactions.getById(user.organisationId, id);
  }

  @ApiTags('Transactions')
  @ApiOperation({
    summary: 'Correct or confirm the category',
    description:
      'Records a MANUAL decision (who, when, from what, note) without overwriting the original. Resolves open category-related flags, and future transactions with the same description reuse this decision. Send `expectedVersion` to get 409 instead of overwriting someone else’s change.',
  })
  @ApiOkResponse({ description: 'Updated transaction detail' })
  @ApiNotFoundResponse({ description: 'Not found in your organisation' })
  @ApiConflictResponse({
    description: 'Changed by someone else since `expectedVersion`',
  })
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
