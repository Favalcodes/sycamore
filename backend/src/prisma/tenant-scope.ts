import type { PrismaClient } from '../generated/prisma/client.js';

/** Models that belong to an organisation. Everything else is global. */
const TENANT_MODELS = new Set([
  'User',
  'Account',
  'Transaction',
  'ClassificationEvent',
  'ReviewFlag',
  'ImportBatch',
  'IdempotencyKey',
]);

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'upsert',
]);

export class CrossTenantWriteError extends Error {
  constructor(model: string) {
    super(`Refusing to write a ${model} row for a different organisation`);
  }
}

function stampData(
  model: string,
  data: unknown,
  organisationId: string,
): unknown {
  const stamp = (row: Record<string, unknown>) => {
    if (
      row.organisationId !== undefined &&
      row.organisationId !== organisationId
    ) {
      throw new CrossTenantWriteError(model);
    }
    return { ...row, organisationId };
  };
  return Array.isArray(data)
    ? data.map(stamp)
    : stamp(data as Record<string, unknown>);
}

/**
 * Wraps a Prisma client so that, for every tenant-owned model:
 *  - reads, updates and deletes get `organisationId` ANDed into `where`;
 *  - creates get `organisationId` stamped onto the data (and refuse a mismatch).
 *
 * Services receive this scoped client and never pass `organisationId`
 * themselves, so a forgotten filter cannot leak data. Composite foreign keys
 * (organisation_id, parent_id) back this up in the database: a row cannot
 * reference a parent from another organisation.
 *
 * Raw SQL is not covered; raw queries in this codebase take organisationId as
 * an explicit bound parameter.
 */
export function scopeToTenant(client: PrismaClient, organisationId: string) {
  if (!organisationId)
    throw new Error('organisationId is required for a tenant client');

  return client.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);

          const scoped = { ...(args as Record<string, unknown>) };
          if (WHERE_OPERATIONS.has(operation)) {
            scoped.where = {
              ...(scoped.where as object | undefined),
              organisationId,
            };
          }
          if (CREATE_OPERATIONS.has(operation)) {
            const key = operation === 'upsert' ? 'create' : 'data';
            scoped[key] = stampData(model, scoped[key], organisationId);
          }
          return query(scoped as typeof args);
        },
      },
    },
  });
}
