import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.decorators.js';
import { dashboardQuerySchema, DashboardService } from './dashboard.service.js';
import type { DashboardQuery } from './dashboard.service.js';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  summary(
    @CurrentUser() user: AuthUser,
    @Query({ schema: dashboardQuerySchema }) query: DashboardQuery,
  ) {
    return this.dashboard.summary(user.organisationId, query);
  }
}
