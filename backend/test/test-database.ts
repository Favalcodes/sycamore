import 'dotenv/config';

/**
 * Integration tests write to a real database, so they only ever run against
 * TEST_DATABASE_URL, and refuse to start if it is missing or points at the
 * same database as DATABASE_URL. Tests create their own uniquely-named
 * organisations and remove only those afterwards.
 */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set TEST_DATABASE_URL to a separate, disposable database to run the e2e tests.',
    );
  }
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL must not be the same database as DATABASE_URL.',
    );
  }
  return url;
}
