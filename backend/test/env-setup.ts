import { testDatabaseUrl } from './test-database.js';

// Point the app at the test database and make background work explicit:
// the tests drive the worker by hand so outcomes are deterministic.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.JWT_SECRET ??= 'e2e-test-secret-that-is-long-enough-123456';
process.env.WORKER_ENABLED = 'false';
process.env.AI_PROVIDER = 'mock';
process.env.MOCK_AI_LATENCY_MS = '0';
process.env.AI_MAX_REQUESTS_PER_MINUTE = '1000';
process.env.LOG_FORMAT = 'json';
