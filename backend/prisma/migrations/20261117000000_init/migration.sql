-- Trigram matching powers ILIKE search and fuzzy duplicate detection.
-- (On Supabase this extension is usually already installed; IF NOT EXISTS keeps it idempotent.)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('REVENUE', 'PAYROLL', 'SOFTWARE', 'MARKETING', 'TRAVEL', 'UTILITIES', 'RENT', 'TAX', 'TRANSFERS', 'BANK_FEES', 'OTHER');

-- CreateEnum
CREATE TYPE "CategorySource" AS ENUM ('RULES', 'AI', 'LEARNED', 'FALLBACK', 'MANUAL');

-- CreateEnum
CREATE TYPE "ClassificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'CLASSIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "FlagType" AS ENUM ('POSSIBLE_DUPLICATE', 'LARGE_AMOUNT', 'LOW_CONFIDENCE', 'UNEXPECTED_CATEGORY', 'CLASSIFICATION_FAILED');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "bank_name" VARCHAR(100) NOT NULL,
    "account_number" VARCHAR(20) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "external_reference" VARCHAR(128) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "direction" "Direction" NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "description_key" VARCHAR(200) NOT NULL,
    "merchant" VARCHAR(200),
    "transaction_date" TIMESTAMPTZ(3) NOT NULL,
    "category" "Category",
    "category_source" "CategorySource",
    "category_confidence" DECIMAL(4,3),
    "classification_status" "ClassificationStatus" NOT NULL DEFAULT 'PENDING',
    "classification_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_classification_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "classification_lease_until" TIMESTAMPTZ(3),
    "last_classification_error" VARCHAR(500),
    "review_checked_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "import_batch_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classification_events" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "category" "Category" NOT NULL,
    "previous_category" "Category",
    "source" "CategorySource" NOT NULL,
    "provider" VARCHAR(100) NOT NULL,
    "confidence" DECIMAL(4,3),
    "rationale" VARCHAR(1000),
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_flags" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "type" "FlagType" NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "reason" VARCHAR(1000) NOT NULL,
    "details" JSONB,
    "related_transaction_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "created_by_id" UUID,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "rejected_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "organisation_id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("organisation_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisations_slug_key" ON "organisations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_organisation_id_id_key" ON "users"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organisation_id_id_key" ON "accounts"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organisation_id_bank_name_account_number_key" ON "accounts"("organisation_id", "bank_name", "account_number");

-- CreateIndex
CREATE INDEX "transactions_organisation_id_transaction_date_id_idx" ON "transactions"("organisation_id", "transaction_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "transactions_organisation_id_account_id_transaction_date_id_idx" ON "transactions"("organisation_id", "account_id", "transaction_date" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "transactions_organisation_id_category_transaction_date_idx" ON "transactions"("organisation_id", "category", "transaction_date");

-- CreateIndex
CREATE INDEX "transactions_organisation_id_description_key_idx" ON "transactions"("organisation_id", "description_key");

-- CreateIndex
CREATE INDEX "transactions_organisation_id_account_id_amount_minor_transa_idx" ON "transactions"("organisation_id", "account_id", "amount_minor", "transaction_date");

-- CreateIndex
CREATE INDEX "transactions_classification_status_next_classification_at_idx" ON "transactions"("classification_status", "next_classification_at");

-- CreateIndex
CREATE INDEX "transactions_review_checked_at_created_at_idx" ON "transactions"("review_checked_at", "created_at");

-- CreateIndex
CREATE INDEX "transactions_description_trgm_idx" ON "transactions" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "transactions_merchant_trgm_idx" ON "transactions" USING GIN ("merchant" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "transactions_external_reference_trgm_idx" ON "transactions" USING GIN ("external_reference" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_organisation_id_account_id_external_reference_key" ON "transactions"("organisation_id", "account_id", "external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_organisation_id_id_key" ON "transactions"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "classification_events_organisation_id_transaction_id_create_idx" ON "classification_events"("organisation_id", "transaction_id", "created_at");

-- CreateIndex
CREATE INDEX "review_flags_organisation_id_status_created_at_idx" ON "review_flags"("organisation_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_flags_organisation_id_transaction_id_idx" ON "review_flags"("organisation_id", "transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_flags_transaction_id_type_key" ON "review_flags"("transaction_id", "type");

-- CreateIndex
CREATE INDEX "import_batches_organisation_id_created_at_idx" ON "import_batches"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organisation_id_account_id_fkey" FOREIGN KEY ("organisation_id", "account_id") REFERENCES "accounts"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_events" ADD CONSTRAINT "classification_events_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_events" ADD CONSTRAINT "classification_events_organisation_id_transaction_id_fkey" FOREIGN KEY ("organisation_id", "transaction_id") REFERENCES "transactions"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_events" ADD CONSTRAINT "classification_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_organisation_id_transaction_id_fkey" FOREIGN KEY ("organisation_id", "transaction_id") REFERENCES "transactions"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_flags" ADD CONSTRAINT "review_flags_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity rules Prisma's schema language cannot express.
-- ---------------------------------------------------------------------------
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "transactions_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "transactions_confidence_range" CHECK ("category_confidence" IS NULL OR ("category_confidence" >= 0 AND "category_confidence" <= 1)),
  ADD CONSTRAINT "transactions_attempts_non_negative" CHECK ("classification_attempts" >= 0),
  ADD CONSTRAINT "transactions_category_source_pair" CHECK (("category" IS NULL) = ("category_source" IS NULL));

ALTER TABLE "accounts"
  ADD CONSTRAINT "accounts_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "classification_events"
  ADD CONSTRAINT "classification_events_confidence_range" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  -- A manual correction must name the person who made it.
  ADD CONSTRAINT "classification_events_manual_has_actor" CHECK ("source" <> 'MANUAL' OR "actor_user_id" IS NOT NULL);

ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));

-- ---------------------------------------------------------------------------
-- Supabase exposes the public schema through its Data API (PostgREST) to the
-- anon/authenticated roles. Enabling RLS with no policies denies those roles
-- everything. The backend connects as the table owner, which RLS does not
-- restrict, so tenant isolation is enforced by the API layer + composite FKs.
-- ---------------------------------------------------------------------------
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "classification_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
