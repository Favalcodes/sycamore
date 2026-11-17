import { Prisma } from '../generated/prisma/client.js';

/** Prisma P1xxx codes: the database could not be reached or connected to. */
export function isDatabaseConnectionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    /^P10(0[0-9]|1[0-7])$/.test(error.code)
  );
}

/**
 * Supabase's direct host (db.<ref>.supabase.co) resolves to IPv6 only, which
 * many networks cannot reach. The Supavisor pooler hosts work over IPv4.
 */
export function connectionHint(connectionString: string): string | null {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return 'DATABASE_URL is not a valid postgresql:// URL.';
  }
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(host)) {
    return (
      `${host} is Supabase's direct-connection host, which is IPv6-only. ` +
      'If your network has no IPv6, use the pooler URLs instead: Supabase dashboard → Connect → ' +
      '"Transaction pooler" (port 6543) for DATABASE_URL and "Session pooler" (port 5432) for DIRECT_URL. ' +
      'Their user name is postgres.<project-ref> and host aws-…pooler.supabase.com.'
    );
  }
  return null;
}
