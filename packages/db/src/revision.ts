import type { Db } from './db.js';

/**
 * The newest applied migration, which is what /health reports as `schemaRevision` and what
 * Shipyard compares against the image's `dev.d3cloud.shipyard.schema` label.
 */
export async function schemaRevision(db: Db): Promise<string | null> {
  const rows = await db.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    ORDER BY migration_name DESC LIMIT 1`;
  return rows[0]?.migration_name ?? null;
}
