import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ClassificationJob } from './classification.job.js';
import { DetectionJob } from './detection.job.js';

/**
 * In-process poller for the two Postgres-backed queues.
 *
 * The queues are just columns on `transactions` (review_checked_at,
 * classification_status/next_classification_at), so work survives restarts,
 * is visible with plain SQL, and needs no extra infrastructure. In production
 * this loop would run as its own deployment (WORKER_ENABLED=false on API
 * pods), scaled independently; SKIP LOCKED makes multiple workers safe.
 */
@Injectable()
export class ProcessingWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ProcessingWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly enabled: boolean;
  private readonly pollMs: number;

  constructor(
    private readonly detection: DetectionJob,
    private readonly classification: ClassificationJob,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('WORKER_ENABLED', { infer: true });
    this.pollMs = config.get('WORKER_POLL_MS', { infer: true });
  }

  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log('Background worker disabled (WORKER_ENABLED=false)');
      return;
    }
    this.logger.log(`Background worker polling every ${this.pollMs}ms`);
    this.schedule(0);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** One pass over both queues; exposed for tests. */
  async tick(): Promise<{ detected: number; classified: number }> {
    let detected = 0;
    let classified = 0;
    // Detection is cheap and local: drain a few batches per tick.
    for (let i = 0; i < 5; i++) {
      const n = await this.detection.runOnce();
      detected += n;
      if (n === 0) break;
    }
    // Classification is paced by the provider's rate budget inside the job.
    for (let i = 0; i < 5; i++) {
      const n = await this.classification.runOnce();
      classified += n;
      if (n === 0) break;
    }
    return { detected, classified };
  }

  private lastFailure: { message: string; at: number; repeats: number } | null =
    null;

  /** Logs a failure, but a repeating one (e.g. database down) only once a minute. */
  private reportFailure(error: unknown) {
    const message = (error as Error)?.message ?? String(error);
    const now = Date.now();
    const last = this.lastFailure;
    if (last && last.message === message && now - last.at < 60_000) {
      last.repeats += 1;
      return;
    }
    this.logger.error({
      msg: 'Worker tick failed; will retry',
      err: message,
      ...(last?.message === message ? { repeatedTimes: last.repeats } : {}),
    });
    this.lastFailure = { message, at: now, repeats: 0 };
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick()
        .then(() => {
          if (this.lastFailure) this.logger.log('Worker recovered');
          this.lastFailure = null;
        })
        .catch((error: unknown) => this.reportFailure(error))
        .finally(() => this.schedule(this.pollMs));
    }, delay);
  }
}
