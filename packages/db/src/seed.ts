// CLI: `pnpm --filter @postroom/db seed`. Idempotent; reads DATABASE_URL, OPERATOR_NAME, DOMAIN.
import { createDb } from './db.js';
import { seed } from './seeding.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const db = createDb(url);
try {
  const result = await seed(db, {
    operatorName: process.env['OPERATOR_NAME'] ?? 'Operator',
    domain: process.env['DOMAIN'] ?? 'd3cloud.io',
  });
  console.log(
    result.changed
      ? `seeded: domain ${result.domainId}, operator ${result.operatorId}`
      : 'seed: nothing to do',
  );
} finally {
  await db.$disconnect();
}
