# Backend — Transaction Intelligence API

NestJS 12 · Prisma 7 · PostgreSQL (Supabase) · Zod · Gemini.

See the [root README](../README.md) for setup, architecture and design decisions, and [docs/API.md](docs/API.md) for the API reference.

| Script | Purpose |
|---|---|
| `npm run start:dev` | API on :3100 with the background worker |
| `npm run db:setup` | Apply migrations, then seed demo data (non-destructive) |
| `npm run db:migrate` / `npm run db:seed` | Each step on its own |
| `npm test` | Unit tests |
| `npm run test:e2e` | Integration tests (needs `TEST_DATABASE_URL`) |
| `npm run lint` | oxlint |
