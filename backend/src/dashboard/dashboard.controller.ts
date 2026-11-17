import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { dashboardQuerySchema, DashboardService } from './dashboard.service.js';
import type { DashboardQuery } from './dashboard.service.js';

@ApiTags('Dashboard')
@ApiBearerAuth('bearer')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @ApiOperation({
    summary: 'Cash flow, spending by category and open flags',
    description:
      'Totals are in NGN. Transfers between the organisation’s own accounts are excluded from inflow/outflow and reported in `internalTransfers`. `shareBp` is the share of outflow in basis points.',
  })
  @Get()
  summary(
    @CurrentUser() user: AuthUser,
    @Query({ schema: dashboardQuerySchema }) query: DashboardQuery,
  ) {
    return this.dashboard.summary(user.organisationId, query);
  }
}
