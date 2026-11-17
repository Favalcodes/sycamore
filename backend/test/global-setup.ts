import { execSync } from 'node:child_process';
import { testDatabaseUrl } from './test-database.js';

/** Bring the test database's schema up to date before any test runs. */
export default function setup() {
  const url = testDatabaseUrl();
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DIRECT_URL: url, DATABASE_URL: url },
  });
}
