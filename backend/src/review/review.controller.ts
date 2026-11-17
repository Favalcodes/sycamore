import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { uuidParam } from '../transactions/transaction.schemas.js';
import {
  listFlagsQuerySchema,
  resolveFlagSchema,
  ReviewService,
} from './review.service.js';
import type { ListFlagsQuery, ResolveFlagInput } from './review.service.js';

@Controller('review')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get('flags')
  list(
    @CurrentUser() user: AuthUser,
    @Query({ schema: listFlagsQuerySchema }) query: ListFlagsQuery,
  ) {
    return this.review.listFlags(user.organisationId, query);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.review.summary(user.organisationId);
  }

  @Patch('flags/:id')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: resolveFlagSchema }) body: ResolveFlagInput,
  ) {
    return this.review.resolve(user, id, body);
  }
}
