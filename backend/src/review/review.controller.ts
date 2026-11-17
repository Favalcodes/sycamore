import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { uuidParam } from '../transactions/transaction.schemas.js';
import {
  listFlagsQuerySchema,
  resolveFlagSchema,
  ReviewService,
} from './review.service.js';
import type { ListFlagsQuery, ResolveFlagInput } from './review.service.js';

@ApiTags('Review')
@ApiBearerAuth('bearer')
@Controller('review')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @ApiOperation({
    summary: 'List review flags',
    description:
      'Newest first. Each flag has a plain-language `reason`. Pass `pageInfo.nextCursor` as `cursor` for the next page.',
  })
  @Get('flags')
  list(
    @CurrentUser() user: AuthUser,
    @Query({ schema: listFlagsQuerySchema }) query: ListFlagsQuery,
  ) {
    return this.review.listFlags(user.organisationId, query);
  }

  @ApiOperation({ summary: 'Open flag counts by type' })
  @Get('summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.review.summary(user.organisationId);
  }

  @ApiOperation({
    summary: 'Resolve or dismiss a flag',
    description:
      'RESOLVED = acted on; DISMISSED = false positive. Records who closed it, when and why.',
  })
  @ApiOkResponse({ description: 'The closed flag' })
  @ApiNotFoundResponse({ description: 'No such flag in your organisation' })
  @ApiBadRequestResponse({ description: 'Flag is already closed' })
  @Patch('flags/:id')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', { schema: uuidParam }) id: string,
    @Body({ schema: resolveFlagSchema }) body: ResolveFlagInput,
  ) {
    return this.review.resolve(user, id, body);
  }
}
