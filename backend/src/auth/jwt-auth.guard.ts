import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthUser, IS_PUBLIC } from './auth.decorators.js';

interface TokenPayload {
  sub: string;
  org: string;
  email: string;
}

/**
 * Registered globally: every route requires a valid bearer token unless it is
 * marked @Public(). The tenant (organisationId) is read from the signed token
 * and nowhere else — clients cannot choose which organisation they act for.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token)
      throw new UnauthorizedException('Missing bearer token');

    try {
      const payload = await this.jwt.verifyAsync<TokenPayload>(token);
      if (!payload.sub || !payload.org) throw new Error('incomplete token');
      req.user = {
        userId: payload.sub,
        organisationId: payload.org,
        email: payload.email,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
