# API reference

Base URL: `http://localhost:3100/api`. Every endpoint except `POST /auth/login` and `GET /health` needs `Authorization: Bearer <token>`.

The organisation you act for comes from the token. No request parameter can select another organisation, and another organisation's ids answer `404`, exactly as ids that do not exist.

**Interactive docs:** with the API running, open **Swagger UI** at `http://localhost:3100/api/docs`. The OpenAPI JSON is at `/api/docs-json`.

Runnable examples for each endpoint are in [`requests.http`](../requests.http). It works with the VS Code REST Client and JetBrains HTTP Client.

## Conventions

**Money** is always a string.
- Request: `"amount": "12999.75"`, a positive decimal with at most 2 places. JSON numbers are rejected.
- Response: `{ "minor": "1299975", "value": "12999.75", "currency": "NGN" }`. `minor` is integer kobo.

**Dates**
- Request: either `YYYY-MM-DD`, read as midnight in Lagos, or a full ISO date-time with an offset.
- Response: UTC ISO-8601.

**Errors** always have this shape:

```json
{ "statusCode": 409, "error": "Conflict", "message": "...", "requestId": "..." }
```

The `requestId` matches the `X-Request-Id` response header and the server logs.

**Pagination** is keyset-based. Pass `pageInfo.nextCursor` back as `cursor`. There is deliberately no total count.

## Auth

### `POST /auth/login`
Rate-limited to 10 requests per minute.

```json
{ "email": "amaka@ofada.test", "password": "Password123!" }
```

Returns `200`:

```json
{
  "accessToken": "…",
  "tokenType": "Bearer",
  "user": { "id": "…", "email": "…", "name": "…" },
  "organisation": { "id": "…", "name": "…", "slug": "…" }
}
```

Returns `401` for a wrong email or password. The response is the same in both cases and takes the same time.

### `GET /auth/me`
Returns the current user and organisation.

## Accounts

### `GET /accounts`
Lists the organisation's accounts with their inflow and outflow totals.

## Transactions

### `POST /transactions`
Imports one transaction.

```json
{
  "externalReference": "GTB-2026-11-000123",
  "accountId": "uuid",
  "amount": "12999.75",
  "currency": "NGN",
  "direction": "DEBIT",
  "description": "SLACK TECHNOLOGIES",
  "merchant": "Slack",
  "date": "2026-11-03"
}
```

`currency` defaults to `NGN` and must match the account's currency. `merchant` is optional.

| Status | Meaning |
|---|---|
| `201` | Created. Body is `{ "duplicate": false, "transaction": {…} }`. |
| `200` | This `(accountId, externalReference)` already exists with identical details. Body is `{ "duplicate": true, "transaction": {…existing} }`. Safe to retry. |
| `400` | Validation failed. |
| `404` | Unknown account. |
| `409` | `REFERENCE_CONFLICT`: the reference is already used with different details. |
| `422` | `CURRENCY_MISMATCH` with the account's currency. |

### `POST /transactions/batch`
Imports 1–1000 transactions.

```json
{ "transactions": [ { …same shape as above… } ] }
```

Returns `200` whenever the envelope is valid, with an outcome for every item:

```json
{
  "batchId": "uuid",
  "total": 3, "created": 1, "duplicates": 1, "rejected": 1,
  "results": [
    { "index": 0, "status": "created",   "externalReference": "A1", "transactionId": "…" },
    { "index": 1, "status": "duplicate", "externalReference": "A0", "transactionId": "…" },
    { "index": 2, "status": "rejected",  "externalReference": "A2", "code": "VALIDATION_FAILED",
      "errors": ["amount: amount must be a decimal string such as \"12999.75\", not a JSON number"] }
  ]
}
```

Rejection codes:
- `VALIDATION_FAILED`
- `DUPLICATE_IN_BATCH`
- `ACCOUNT_NOT_FOUND`
- `CURRENCY_MISMATCH`
- `REFERENCE_CONFLICT`

**Idempotency-Key header** (optional on both import endpoints, 8–200 characters):
- Same key and same body: the stored response is returned with `Idempotent-Replayed: true`.
- Same key and a different body: `422`.
- Same key while the first request is still running: `409`.
- Failed requests are not stored, so the client can retry with the same key.

Even without the header, re-sending a transaction never creates a second row, because `(account, externalReference)` is unique.

### `GET /transactions`
Lists transactions, newest first. Query parameters (all optional):

| Param | Notes |
|---|---|
| `limit` | 1–100, default 25 |
| `cursor` | From `pageInfo.nextCursor` |
| `q` | Searches description, merchant and reference. Case-insensitive, matches substrings. |
| `accountId` | |
| `direction` | `CREDIT` / `DEBIT` |
| `category` | A category, or `UNCATEGORISED` |
| `classificationStatus` | `PENDING` / `PROCESSING` / `CLASSIFIED` / `FAILED` |
| `flagged` | `true` keeps only transactions with an open review flag. `false` keeps only those without. |
| `from`, `to` | Dates |
| `minAmount`, `maxAmount` | Decimal strings |

Response: `{ "data": [TransactionSummary], "pageInfo": { "limit", "hasMore", "nextCursor" } }`.

### `GET /transactions/:id`
Returns the full detail: account, flags (open and closed), and the classification block below. Use `version` for optimistic concurrency when correcting.

```json
"classification": {
  "attempts": 1,
  "lastError": null,
  "original":   { "category": "MARKETING", "source": "AI", "provider": "gemini:…", "confidence": 0.42, "rationale": "…", "createdAt": "…" },
  "correction": { "by": { "name": "Amaka Okafor", … }, "at": "…", "from": "MARKETING", "note": "Shop rent" },
  "history": [ …every decision, oldest first… ]
}
```

### `PATCH /transactions/:id/category`
Manual correction.

```json
{ "category": "RENT", "note": "Monthly shop rent", "expectedVersion": 3 }
```

- Appends a `MANUAL` event. Earlier decisions are never overwritten.
- Resolves open `LOW_CONFIDENCE`, `UNEXPECTED_CATEGORY` and `CLASSIFICATION_FAILED` flags.
- Future transactions with the same description reuse the corrected category (`LEARNED`).
- Returns `409` if `expectedVersion` is stale.

Categories:
- `REVENUE`
- `PAYROLL`
- `SOFTWARE`
- `MARKETING`
- `TRAVEL`
- `UTILITIES`
- `RENT`
- `TAX`
- `TRANSFERS`
- `BANK_FEES`
- `OTHER`

## Review

### `GET /review/flags`
Query parameters:
- `status`: `OPEN` (default), `RESOLVED` or `DISMISSED`
- `type`
- `limit`
- `cursor`: the last flag id from the previous page

Each flag carries a plain-language `reason` and a transaction summary.

Flag types:
- `POSSIBLE_DUPLICATE`
- `LARGE_AMOUNT`
- `LOW_CONFIDENCE`
- `UNEXPECTED_CATEGORY`
- `CLASSIFICATION_FAILED`

### `GET /review/summary`
Returns open flag counts by type.

### `PATCH /review/flags/:id`
Closes a flag and records who closed it and when. Use `RESOLVED` when the flag was acted on and `DISMISSED` for a false positive.

```json
{ "status": "RESOLVED", "note": "Called the supplier; second payment will be refunded" }
```

## Dashboard

### `GET /dashboard?from=&to=&accountId=`
Returns:
- `totals`: inflow, outflow, net and transaction count. Transfers between the organisation's own accounts are excluded and reported separately in `internalTransfers`.
- `spendingByCategory`: debits by category, each with its share of outflow in basis points.
- `classification`: transaction counts by status.
- `flags`: open count, counts by type, and the most recent flags.

## Health

### `GET /health`
No authentication. Returns:
- database status
- classification provider and circuit-breaker state
- rate-limit wait
- queue depth by status
- age of the oldest pending item
