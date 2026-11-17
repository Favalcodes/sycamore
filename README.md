# Transaction Intelligence Platform

A multi-tenant service where Nigerian businesses can:
- import bank transactions;
- have them categorised automatically by rules, a memory of past decisions, and an LLM;
- get transactions that need a person's attention flagged, each with a plain-language reason;
- review and correct those decisions, with a full audit trail.

| Folder | Stack |
|---|---|
| [`backend/`](backend) | NestJS 12, TypeScript, PostgreSQL (Supabase), Prisma 7, Zod, Gemini |
| [`frontend/`](frontend) | Vue 3, TypeScript, Vite, Tailwind CSS 4, Vue Router, Pinia |

The two folders are independent projects, each with its own `package.json`, lockfile and tooling. There are no workspaces and no shared packages.

---

## Running it locally

**Requirements:**
- Node.js 22.18+ or 24.12+
- A Supabase project (the free tier is fine)
- Optionally, a free Gemini API key from <https://aistudio.google.com/apikey>. Without a key the app uses a built-in mock AI provider.

### 1. Backend

```bash
cd backend
npm install                 # also generates the Prisma client
cp .env.example .env        # then fill in the values below
npm run db:setup            # applies migrations, then seeds demo data
npm run start:dev           # http://localhost:3100/api
```

Values to set in `backend/.env`:
- **`DATABASE_URL`**: Supabase dashboard → **Connect** → *Transaction pooler* URI (port 6543). The running app uses this.
- **`DIRECT_URL`**: the *Session pooler* or direct URI (port 5432). Migrations and the seed use this.
- **`JWT_SECRET`**: any random string of 32 or more characters. To generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
- **`GEMINI_API_KEY`**: optional. Leave it empty to use the mock provider.

The seed never deletes anything and can safely be re-run. It creates two organisations with about six months of activity each. All demo users have the password `Password123!`:

| Email | Organisation |
|---|---|
| `amaka@ofada.test` | Ofada Kitchen Supplies Ltd (food distribution, Lagos) |
| `tunde@ofada.test` | Ofada Kitchen Supplies Ltd |
| `hauwa@kanem.test` | Kanem Logistics Nigeria Ltd (haulage, Abuja) |
| `emeka@kanem.test` | Kanem Logistics Nigeria Ltd |

When the API starts, its background worker runs review detection and AI classification on the seeded transactions. This takes about a minute with Gemini's free tier.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173  (proxies /api to :3100)
```

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Backend logs `Cannot reach the database at db.<ref>.supabase.co` (with a hint) | Supabase's direct host is IPv6-only, and many networks have no IPv6. Use the **pooler** strings from Supabase → **Connect**. *Transaction pooler* (port 6543) goes in `DATABASE_URL` and *Session pooler* (port 5432) in `DIRECT_URL`. Their user name is `postgres.<project-ref>`. |
| Login shows "Cannot reach the API server" | The backend isn't running on the port the frontend proxies to. Make `API_PROXY_TARGET` in `frontend/.env` match `PORT` in `backend/.env` (default 3100). |
| Login shows an unfamiliar validation error | Another app is answering on that port. Check with `lsof -nP -iTCP:<port> -sTCP:LISTEN` and choose a free `PORT`. |

### 3. Tests

```bash
cd backend
npm test                    # 103 unit tests, no database needed
npm run test:e2e            # 31 integration tests against a real Postgres
npm run lint

cd ../frontend
npm run test:unit
npm run type-check
```

`test:e2e` needs **`TEST_DATABASE_URL`** pointing at a separate, disposable database, such as a second Supabase project or a local Postgres. It refuses to run if that is missing or is the same database as `DATABASE_URL`. It applies migrations itself, creates uniquely named organisations, and removes only those afterwards.

### API documentation

- **Swagger UI:** <http://localhost:3100/api/docs>. It is interactive: call `POST /api/auth/login`, click **Authorize**, paste the `accessToken`, and try any endpoint. The OpenAPI JSON is at `/api/docs-json` (importable into Postman or Insomnia).
  - The request bodies, query strings and path parameters come from the **same Zod schemas the API validates with**, so the docs cannot drift from what the API accepts.
  - An integration test checks the document.
- [`backend/docs/API.md`](backend/docs/API.md): conventions and status codes in prose.
- [`backend/requests.http`](backend/requests.http): a runnable collection for the VS Code REST Client or JetBrains HTTP Client.

---

## Architecture

```
            ┌──────────── Vue SPA ────────────┐
            │ Dashboard · Transactions · Review │
            └───────────────┬──────────────────┘
                            │ JWT (organisation id is inside the signed token)
┌───────────────────────────▼─────────────────────────────────────┐
│ NestJS API                                                       │
│  auth ─ transactions (import, list, detail, correct) ─ review ─   │
│  dashboard ─ health                                              │
│         │ tenant-scoped Prisma client (organisationId injected)   │
│  import path: validate → rules → recall memory → INSERT … ON      │
│               CONFLICT DO NOTHING → classification event          │
│                                     (no network calls)            │
├──────────────────────────────────────────────────────────────────┤
│ Background worker (same process locally; separate deployment in   │
│ production). Queues are columns on `transactions`, claimed with   │
│ FOR UPDATE SKIP LOCKED:                                           │
│  • review detection: duplicates, large amounts  (no AI dependency)│
│  • classification:   memory → rate limiter → circuit breaker →    │
│                      provider (Gemini | mock) → validate → write   │
└───────────────────────────┬──────────────────────────────────────┘
                            ▼
              PostgreSQL (Supabase): BIGINT kobo, composite tenant
              foreign keys, CHECK constraints, trigram search
              indexes, append-only classification_events
```

### Data model (main tables)

- **`organisations`, `users`, `accounts`**: every tenant-owned row carries `organisation_id`.
- **`transactions`**:
  - amount stored as `amount_minor BIGINT` (kobo), with a CHECK that it is above 0, plus a separate `direction`;
  - unique on `(organisation_id, account_id, external_reference)`;
  - the current category, its source and confidence;
  - the queue columns for classification and review detection;
  - a `version` column for optimistic concurrency.
- **`classification_events`**: an append-only history of every decision: rules, AI, learned, fallback and manual. Each records the provider/model, confidence and rationale. Manual decisions also record the person who made them; a CHECK constraint enforces this.
- **`review_flags`**: one per (transaction, type). Each has a human-readable `reason`, structured `details`, and who resolved it, when and why.
- **`import_batches`**, **`idempotency_keys`**.

---

## Key decisions

### Financial correctness

**How ₦12,999.75 travels through the system:**

1. **API input** is the string `"12999.75"`.
   - JSON numbers are **rejected** with an explanation. A number has already passed through binary floating point before the server sees it, so accepting it would hide upstream bugs.
   - The format is validated as up to 15 whole digits plus at most 2 decimal places.
2. **Parsing** splits the string on `.` and computes `12999n * 100n + 75n = 1299975n`. It is a JavaScript `bigint` from the start and never becomes a `number`.
3. **Storage** is `BIGINT 1299975` in kobo, with a CHECK that it is above 0. Whether money came in or went out is stored in the separate `direction` column, never as a negative amount.
4. **Aggregation** happens in Postgres. `SUM(bigint)` returns `numeric`, which cannot overflow. The result comes back to Node as a `bigint`.
5. **Output** has the shape `{ "minor": "1299975", "value": "12999.75", "currency": "NGN" }`.
   - Both values are strings, because JSON numbers cannot hold every 64-bit integer.
   - The frontend formats `value` with `Intl.NumberFormat`, which formats a string exactly.

Basis-point shares and ratios are also computed in integer arithmetic. Tests check that ₦0.10 + ₦0.20 comes to exactly ₦0.30, end to end through the dashboard, and that values above `Number.MAX_SAFE_INTEGER` survive the round trip.

### Tenant isolation

Isolation is enforced in four layers:

1. **Identity.** `organisationId` is read only from the verified JWT. No request field can choose a tenant.
2. **Scoped data access.** Request handlers use `prisma.forTenant(orgId)`, a Prisma client extension:
   - every query on a tenant-owned model gets `organisation_id = $org` added to its `where`;
   - every create gets the organisation id stamped onto it;
   - writing a row for another organisation throws.

   A forgotten filter cannot leak data. Raw SQL (detectors, queue claims) passes the organisation id explicitly as a bound parameter.
3. **Database.** Child rows reference their parent through composite foreign keys `(organisation_id, parent_id)`. For example, a transaction cannot point at another organisation's account, even through a bug or a raw insert.
4. **No existence leaks.** Another organisation's ids return `404`, the same as ids that don't exist.

Supabase also exposes the `public` schema through its Data API. The migration enables row-level security with no policies on every table. That denies Supabase's `anon` and `authenticated` roles everything, while the backend, which connects as the table owner, is unaffected.

The tests prove each layer: reading, listing, searching, correcting and resolving flags across tenants; importing into another organisation's account; the scoped client refusing a cross-tenant write; and the database refusing a cross-tenant foreign key.

### Import: idempotency, concurrency, partial failure

- **Natural key.** `(organisation, account, external_reference)` is unique. Inserts use `INSERT … ON CONFLICT DO NOTHING RETURNING`, so under concurrency the losing request skips cleanly instead of failing. Re-sending a transaction returns the existing one (`duplicate`).
- **Conflicting reuse.** Re-using a reference with different details is reported as `REFERENCE_CONFLICT`. It never silently overwrites.
- **Idempotency-Key header** (Stripe-style):
  - the request body is hashed and the response stored;
  - a replay returns the stored response with `Idempotent-Replayed: true`;
  - the same key with a different body gets `422`;
  - the same key while the first request is still running gets `409`;
  - failed requests are not stored, so retrying with the same key works.
- **Batches** take up to 1000 items. Each item is validated on its own and reported as `created`, `duplicate` or `rejected`, with a code and reasons. Valid items commit even when others fail. The batch is one interactive transaction of about three queries, not one round trip per row.
- **Proven by tests:**
  - 25 concurrent identical requests create exactly one row (1 × 201, 24 × 200);
  - 5 overlapping 30-item batches create exactly 30 rows.

### Classification: layered, and cheap by default

| Step | When | Cost |
|---|---|---|
| 1. **Keyword rules** | At import, synchronously. ~84% of seed data is decided here: bank fees, PAYE/VAT, payroll, rent, SaaS, utilities, settlements, own-account sweeps. | Free |
| 2. **Decision memory** (`LEARNED`) | At import and in the worker. A normalised description (digits and punctuation folded) matches an earlier decision made by a **person**, or by the **AI with ≥80% confidence and no open doubt**. A reviewer's correction therefore applies to future identical transactions. | One indexed query |
| 3. **Batch deduplication** | In the worker. Identical descriptions in a claimed batch go to the model once. | — |
| 4. **LLM** (Gemini, `gemini-3.5-flash-lite` by default) | Worker only. Up to 20 transactions per request, JSON-schema-constrained output, temperature 0. | Paid / quota |

**Provider abstraction.** Every model is a provider, and nothing outside `src/classification/providers/` knows which one is in use.

| File | Role |
|---|---|
| `provider.ts` | `ClassificationProvider` interface (`classify(inputs, signal)`) and the typed `ProviderError` (`TIMEOUT`, `UNAVAILABLE`, `RATE_LIMITED`, `INVALID_RESPONSE`). The queue, retries and circuit breaker only depend on this. |
| `providers/llm-provider.ts` | `LlmProvider`, the base class for every LLM. It holds what must not differ between vendors: the prompt and category definitions, short ids instead of database ids, the deadline, JSON parsing (including code-fenced answers), per-item validation, and HTTP status → `ProviderError` mapping. |
| `providers/gemini.provider.ts` | Gemini: implements `complete()` with the Google SDK, maps Gemini's 429 retry hint, and declares its own settings (`GEMINI_API_KEY`, `GEMINI_MODEL`). |
| `providers/mock-ai.provider.ts` | Deterministic mock with configurable latency and failure rate (`MOCK_AI_*`), for local use and outage drills. |
| `providers/registry.ts` | The list of providers. `AI_PROVIDER=<id>` picks one. If unset, the first configured one is used (Gemini when its key is set, otherwise the mock). |

At startup the chosen provider's own settings are validated. An unknown `AI_PROVIDER`, or a missing key, stops the app with a message listing the available providers.

#### Adding another LLM

Adding, for example, OpenAI takes one new file and one line in the registry; no other code changes.

```ts
// src/classification/providers/openai.provider.ts
export class OpenAiProvider extends LlmProvider {
  readonly name: string;
  constructor(private readonly opts: { apiKey: string; model: string; timeoutMs: number }) {
    super(opts.timeoutMs);
    this.name = `openai:${opts.model}`;
  }
  // The only vendor-specific part: send the request, return the text.
  protected async complete({ system, prompt, jsonSchema, signal }: LlmRequest) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'results', schema: jsonSchema } },
      }),
    });
    if (!res.ok) throw providerErrorFromStatus(this.name, res.status);
    return (await res.json()).choices[0]?.message?.content;
  }
}

export const openAiProvider = defineProvider({
  id: 'openai',
  description: 'OpenAI chat models',
  configSchema: z.object({ OPENAI_API_KEY: z.string().min(1), OPENAI_MODEL: z.string().default('gpt-4o-mini') }),
  isConfigured: (env) => Boolean(env.OPENAI_API_KEY),
  create: (c, shared) => new OpenAiProvider({ apiKey: c.OPENAI_API_KEY, model: c.OPENAI_MODEL, timeoutMs: shared.timeoutMs }),
});
```

Then add `openAiProvider` to `PROVIDERS` in `registry.ts` and set `AI_PROVIDER=openai`.

Everything else comes for free from the base class and the pipeline:
- the prompt, validation and audit trail
- the provider name recorded on every decision
- rate limiting, the circuit breaker and retries

The tests in `llm-provider.spec.ts` show the minimum a provider has to satisfy.

**AI output is untrusted.**
- Transaction text is passed as JSON data, and the system instruction tells the model never to follow instructions found inside it.
- The output is constrained by a JSON schema and validated **item by item** with Zod:
  - categories must come from the enum;
  - confidence must be between 0 and 1;
  - ids the model invents and repeated ids are dropped.
- Valid items are kept even when their neighbours are invalid.

### AI reliability

- **Import never calls the AI.** It only enqueues work, so an outage cannot slow down or fail an import. A test shows this with a provider that is down.
- **The queue lives in Postgres.**
  - Items are claimed with `FOR UPDATE SKIP LOCKED` and a 2-minute lease, so a crashed worker's rows are picked up again.
  - The slow AI call happens outside any database transaction.
  - Results are written only if the row is still `PROCESSING` **and not manually corrected**. A person's correction made while the AI is working always wins; a test covers this.
- **Timeouts.** Each call has a hard deadline (`AbortSignal`) and the SDK's hidden retries are disabled. Retries are the queue's job, where they are backed off and visible.
- **Circuit breaker.** After 5 consecutive failures the worker **stops claiming work**. It then makes one probe call per interval, so the backlog waits in `PENDING`, in arrival order.
- **Rate limiter.** A token bucket keeps calls inside the free tier's quota. A `429` pauses until the provider's `retryDelay` and is not counted as a failure.
- **Attempts.** Outages, timeouts and rate limits never use up a transaction's attempts. Only item-specific failures do, such as an omitted or unusable answer. After 5 of those the transaction gets the best rule guess (`FALLBACK`), status `FAILED`, and a `CLASSIFICATION_FAILED` flag for a person to confirm.
- **Observability.** `GET /health` shows the circuit state, rate-limit wait, queue depth and the age of the oldest pending item. Logs are structured, with a request id on every request.

### Review detection

Each flag carries a sentence a finance person can act on. For example:

> Possible duplicate of OFD-DUP-00001 (5 Nov 2026): same account, same ₦4,750,000.00 debit, a near-identical description, 1 day apart — but a different reference. Confirm it was not paid twice.

| Flag | Rule |
|---|---|
| `POSSIBLE_DUPLICATE` | Same account, amount and direction, within ±3 days, description trigram similarity ≥ 0.5, but a different reference. Only the later transaction of a pair is flagged. Amounts under ₦5,000 are skipped, because repeated SMS or stamp-duty charges are normal. |
| `LARGE_AMOUNT` | At or above ₦25m (configurable), **or** more than 2.5× the **largest** transaction in the same direction on that account over the previous 90 days (at least 10 prior transactions and ₦1m minimum). Comparing with the maximum rather than the average means recurring large items like payroll stop being "unusual" after their first month. |
| `LOW_CONFIDENCE` | An AI decision below 60% confidence. |
| `UNEXPECTED_CATEGORY` | Money in labelled as an expense (for example a salary reversal labelled Payroll), or money out labelled as Revenue. |
| `CLASSIFICATION_FAILED` | Attempts were exhausted and a fallback category was applied. |

Duplicate and large-amount detection run in their own worker stage, which never depends on the AI. A manual correction resolves the category-related flags automatically and records who resolved them.

---

## Design scenarios

### 1. Six-hour AI outage while hundreds of thousands of transactions arrive

**During the outage:**
- Imports carry on at full speed, because nothing on the import path calls the AI.
- Rules and decision memory still classify the predictable majority **immediately**: recurring payments, fees, tax and payroll. The dashboard stays mostly accurate.
- The remainder is stored as `PENDING`.
- After 5 failures the circuit opens. The worker stops claiming work and sends one probe per interval, so there is no retry storm and no wasted quota. Duplicate and large-amount detection keep running.
- No transaction uses up its attempts while the provider is down.
- `/health` shows the circuit `OPEN` and the oldest pending item getting older. That is what an alert should watch. The dashboard tells users how many transactions are still being categorised.

**After the outage:**
- A probe succeeds and the circuit closes.
- The backlog drains in arrival order, at the speed the rate limiter allows.
- Memory and batch deduplication shrink the backlog as it drains: the first answer for a recurring description is reused for the rest.
- For a backlog this size I would run more worker instances (safe with `SKIP LOCKED`). I would also order the queue by organisation fairly, so that one large customer cannot starve the others.

### 2. Keeping AI costs low at millions of transactions a day

The guiding idea: only pay the model for transactions the business hasn't seen before.

1. **Rules first.** Bank fees, statutory payments, payroll and gateway settlements are most of the volume, and they are free and deterministic.
2. **Decision memory.** Reuse earlier confident and human-confirmed decisions on the same normalised description. Business transaction streams repeat heavily, so most of the remaining volume hits memory. Corrections improve memory over time.
3. **Batching and deduplication.** 20 transactions per request, sent with short ids, and each distinct description sent only once.
4. **Smallest model that's accurate enough** (flash-lite). Escalate to a larger model only for low-confidence answers, which works like a cascade.
5. **Measure it.** Keep a labelled sample from human corrections. Track accuracy per category and the share of decisions coming from each source. Tune the rule and memory thresholds against that sample rather than guessing.
6. **Further options:**
   - provider batch APIs, which are cheaper and asynchronous, for traffic that isn't time-sensitive;
   - prompt caching for the fixed system instruction;
   - per-tenant merchant tables.

### 3. Scaling from 100,000 to 10 million transactions a day

10 million a day is about 115 a second on average, with peaks perhaps 5–10 times that.

- **Ingestion.** Make imports API-light: accept a batch, write it to a staging table or object storage, and acknowledge it. Workers then validate and insert in bulk with `COPY` or multi-row inserts. Use a real queue (SQS or Kafka) once the Postgres queue becomes contended.
- **Database.**
  - Partition `transactions` by month (range on `transaction_date`). Old partitions can then be detached or archived and the indexes stay small.
  - Move to a dedicated Postgres instance, or Citus sharded on `organisation_id`.
  - Use PgBouncer or Supavisor in transaction mode for API pods.
  - Add read replicas for listings and dashboards.
- **Reads.**
  - Keyset pagination already costs the same at any depth, and there is no `COUNT(*)`.
  - Dashboards move from live `GROUP BY` to pre-computed **daily rollups** per organisation, account, category and direction, updated by the worker.
  - Search would move to a dedicated search engine (OpenSearch) if trigram indexes become too costly to maintain on writes.
- **Workers.**
  - Separate deployments for detection and classification, with autoscaling based on queue age.
  - The circuit breaker and rate-limit state move to Redis, so the quota is shared across instances.
  - Fair scheduling across organisations.
- **Operations.** Metrics and traces (OpenTelemetry), alerts on queue age and circuit state, and load tests with realistic batch shapes.

### 4. "Inaccurate AI categorisation has made our finance team distrust the dashboard"

**Investigate with data, not anecdotes.** The audit trail makes this possible:
- The correction rate by category, source (rules, AI, learned, fallback), model version and time period comes straight from `classification_events`.
- Look for systematic errors: one rule that is too broad (I fixed one during this build — "diesel" was catching truck purchases); a category the model confuses; memory spreading one bad decision; a particular account's description format.
- Pull the specific transactions the finance team mentions and walk through each one's history.

**Fix the root cause:**
- Correct or narrow the rules.
- Adjust the prompt or category definitions with the customer's own vocabulary.
- Raise the confidence threshold for automatic acceptance.
- Use their corrections as few-shot examples or tenant-specific memory.
- For a decision memory has spread, bulk re-classify with the fix and keep the audit trail.

**Rebuild trust in the product:**
- Show how sure each number is. The dashboard already separates "awaiting classification" and shows each decision's source and confidence.
- Add a "needs confirmation" view of material uncategorised or low-confidence spend.
- Let the team lock categories for a closed period.
- Report accuracy back to them each month ("97.8% of last month's AI decisions were accepted unchanged").

Then follow up with the customer on what was changed and the before-and-after numbers.

---

## Assumptions

- One user belongs to one organisation. Email addresses are unique across the platform, so login needs no organisation hint. There are no roles yet; every user in an organisation can review.
- Transactions are positive amounts plus a direction. Accounts have one currency, and a transaction's currency must match its account's. Dashboard totals are in NGN, the primary currency.
- `externalReference` is unique per account, as bank references are.
- A date-only `date` means midnight in Africa/Lagos. Dates more than a day in the future are rejected.
- Transfers between the organisation's own accounts (category Transfers) are excluded from inflow and outflow totals and shown separately, so they don't inflate cash flow.

## Trade-offs

- **Postgres as the queue** rather than Redis or SQS: durable, transactional with the data, visible with plain SQL, and no extra infrastructure. It is fine at this scale; scenario 3 covers when to move on.
- **The worker runs inside the API process locally**, so there is one thing to run. `WORKER_ENABLED=false` turns it off on API pods in production.
- **Circuit breaker and rate-limiter state is per process.** It would be shared in Redis once there are several workers.
- **App-level tenant scoping plus composite foreign keys rather than Postgres RLS policies.** RLS would need a non-owner database role and per-request session variables through Supabase's transaction pooler. That is the next hardening step (see below).
- **Categories are a fixed enum.** That is simple and type-safe. Per-tenant custom categories would need a table.
- **No total count on listings.** This was deliberate for performance; the UI uses next and previous pages.
- **Hand-written retry, circuit breaker and idempotency** rather than Nest's new `@nestjs/resilience` and `@nestjs/idempotency` packages. They are central to what is being assessed, small, and fully unit-tested, and they are tied to database state, such as attempts not being used up during an outage. I would evaluate the first-party packages before production.

## Potential improvements

- **Postgres RLS** as a second enforcement layer, with a dedicated `app_user` role and `SET LOCAL app.organisation_id` per transaction.
- **Roles and permissions**: viewer, reviewer and admin, plus approval steps for large-amount flags.
- **CSV and statement-file import**, mapping each bank's format to the import API, with progress shown per batch.
- **"Apply to similar"** when correcting: re-label existing transactions with the same description in one action, not just future ones.
- **Bulk re-classification and replay** after a prompt or model change, with old and new results compared on a labelled set.
- **Rollup tables** for dashboards, and **monthly partitions** for transactions.
- **Metrics and tracing**: OpenTelemetry, and Prometheus metrics for queue depth, provider latency and error rate, and cost per organisation.
- **More detectors**: unusual frequency, such as many payments to one beneficiary in a short window; first payment to a new beneficiary above a threshold; weekend or late-night large transfers.
- **Frontend**: saved filters, keyboard shortcuts in the review queue, and charts of cash flow over time.

## Testing

- **Backend unit tests (103)**: the provider layer (shared LLM base class, Gemini against a fake SDK client, registry selection and config errors), money parsing and formatting (including ₦12,999.75 and values above `MAX_SAFE_INTEGER`), the rules (Nigerian banking descriptions), the circuit breaker and rate limiter, the classification pipeline's behaviour under timeout, outage, rate limit and invalid output, model-output validation, request validation, cursors and backoff.
- **Backend integration tests (31, real Postgres)**: the generated Swagger/OpenAPI document; tenant isolation at the API, client and database layers; money end to end; concurrent and racing imports; Idempotency-Key replay and misuse; partial batch failure; keyset pagination; filters; correction audit trail and optimistic locking; decision memory; an AI outage and recovery; fallback after exhausted attempts; a human correction during an in-flight AI call; duplicate and large-amount explanations.
- **Frontend**: exact money formatting and the password visibility toggle.
