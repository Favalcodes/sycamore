import { Module } from '@nestjs/common';
import { ReviewModule } from '../review/review.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  imports: [ReviewModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
