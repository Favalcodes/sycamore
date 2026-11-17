import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { Prisma } from '../generated/prisma/client.js';
import { requestIdOf } from './request-id.middleware.js';
import { isDatabaseConnectionError } from '../prisma/database-errors.js';

/**
 * One error shape for every failure:
 *   { statusCode, error, message, requestId }
 * Unexpected errors are logged with the request id and returned as a generic
 * 500 so internals (SQL, stack traces) never reach the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = requestIdOf(req);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      error: 'Internal Server Error',
      message: 'Something went wrong',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      const reason = STATUS_CODES[status] ?? 'Error';
      body =
        typeof response === 'string'
          ? { message: response }
          : { ...(response as Record<string, unknown>) };
      body.error = reason;
    } else if (isDatabaseConnectionError(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      body = {
        error: 'Service Unavailable',
        message:
          'The database cannot be reached right now. Please try again shortly.',
        code: 'DATABASE_UNAVAILABLE',
      };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        body = {
          error: 'Conflict',
          message: 'A record with these unique values already exists',
        };
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        body = { error: 'Not Found', message: 'Record not found' };
      }
    }

    if (status >= 500 && status !== HttpStatus.SERVICE_UNAVAILABLE) {
      this.logger.error({
        msg: 'Unhandled error',
        requestId,
        method: req.method,
        path: req.url,
        err: exception instanceof Error ? exception.stack : exception,
      });
    }

    delete body.statusCode;
    res.status(status).json({ statusCode: status, ...body, requestId });
  }
}
