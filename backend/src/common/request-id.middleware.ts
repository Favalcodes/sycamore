import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Gives every request an id (honouring a well-formed inbound X-Request-Id),
 * echoes it on the response, and logs one structured line per request.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const inbound = req.header('x-request-id');
    const id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
    (req as Request & { id: string }).id = id;
    res.setHeader('X-Request-Id', id);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(
        (process.hrtime.bigint() - started) / 1_000_000n,
      );
      const user = (
        req as Request & { user?: { organisationId: string; userId: string } }
      ).user;
      this.logger.log({
        requestId: id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs,
        organisationId: user?.organisationId,
        userId: user?.userId,
      });
    });
    next();
  }
}

export function requestIdOf(req: unknown): string | undefined {
  return (req as { id?: string } | undefined)?.id;
}
