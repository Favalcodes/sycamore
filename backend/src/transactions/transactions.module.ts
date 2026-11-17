import { Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';

@Module({
  controllers: [TransactionsController],
  providers: [TransactionsService, IdempotencyService],
})
export class TransactionsModule {}
