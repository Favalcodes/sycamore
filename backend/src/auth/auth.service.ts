import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';

// Compared against when the email is unknown, so response time does not
// reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-real-password', 12);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    // Login is the one place that looks a user up before a tenant is known,
    // so it uses the unscoped client.
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      include: {
        organisation: { select: { id: true, name: true, slug: true } },
      },
    });

    const valid = await bcrypt.compare(
      password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !valid)
      throw new UnauthorizedException('Incorrect email or password');

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      org: user.organisationId,
      email: user.email,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      user: { id: user.id, email: user.email, name: user.name },
      organisation: user.organisation,
    };
  }

  async me(userId: string, organisationId: string) {
    const user = await this.prisma.forTenant(organisationId).user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        organisation: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!user) throw new UnauthorizedException();
    const { organisation, ...rest } = user;
    return { user: rest, organisation };
  }
}
