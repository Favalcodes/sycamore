import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { CurrentUser, Public } from './auth.decorators.js';
import type { AuthUser } from './auth.decorators.js';

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Exchanges email + password for a JWT. Rate-limited against brute force. */
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Exchanges email and password for a JWT (valid 8 hours). Rate-limited to 10 attempts per minute.',
  })
  @ApiOkResponse({ description: 'accessToken, user and organisation' })
  @ApiUnauthorizedResponse({ description: 'Incorrect email or password' })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts' })
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body({ schema: loginSchema }) body: z.infer<typeof loginSchema>) {
    return this.auth.login(body.email, body.password);
  }

  @ApiOperation({ summary: 'Current user and organisation' })
  @ApiBearerAuth('bearer')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId, user.organisationId);
  }
}
