import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// The Prisma CLI (migrate, db seed) needs a session-capable connection, so it
// uses DIRECT_URL (Supabase direct connection or session pooler, port 5432).
// The running app uses DATABASE_URL (Supabase transaction pooler, port 6543).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'],
  },
});
