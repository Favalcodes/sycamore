import { Module } from '@nestjs/common';
import { ClassificationModule } from '../classification/classification.module.js';
import { ClassificationJob } from './classification.job.js';
import { DetectionJob } from './detection.job.js';
import { ProcessingWorker } from './processing.worker.js';

@Module({
  imports: [ClassificationModule],
  providers: [DetectionJob, ClassificationJob, ProcessingWorker],
  exports: [ProcessingWorker],
})
export class ProcessingModule {}
