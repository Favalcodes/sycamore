import { Prisma } from '../generated/prisma/client.js';
import {
  connectionHint,
  isDatabaseConnectionError,
} from './database-errors.js';

describe('database connection errors', () => {
  it('recognises Prisma connection failures (P1xxx) but not query errors', () => {
    const known = (code: string) =>
      new Prisma.PrismaClientKnownRequestError('x', {
        code,
        clientVersion: 'test',
      });
    expect(isDatabaseConnectionError(known('P1001'))).toBe(true);
    expect(isDatabaseConnectionError(known('P1017'))).toBe(true);
    expect(isDatabaseConnectionError(known('P2002'))).toBe(false);
    expect(isDatabaseConnectionError(new Error('P1001'))).toBe(false);
  });

  it('explains the IPv6-only Supabase direct host and suggests the pooler', () => {
    expect(
      connectionHint('postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres'),
    ).toMatch(/IPv6-only.*pooler/);
    expect(
      connectionHint(
        'postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
      ),
    ).toBeNull();
    expect(connectionHint('not a url')).toMatch(/not a valid/);
  });
});
