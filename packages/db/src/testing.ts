// Throwaway databases for integration tests: a fresh database per suite, migrated with the real
// migrations, dropped afterwards. Never used outside tests.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { createDb, type Db } from './db.js';

const exec = promisify(execFile);
const pkgDir = fileURLToPath(new URL('..', import.meta.url));

export interface TestDatabase {
  url: string;
  name: string;
  db: Db;
  drop: () => Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Create and migrate `<prefix>_<random>` on the server `baseUrl` points at. */
export async function createTestDatabase(baseUrl: string, prefix = 'pst_test'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(baseUrl, name);
  const prisma = fileURLToPath(new URL('../node_modules/.bin/prisma', import.meta.url));
  await exec(prisma, ['migrate', 'deploy'], { cwd: pkgDir, env: { ...process.env, DATABASE_URL: url } });
  const db = createDb(url);
  return {
    url,
    name,
    db,
    drop: async () => {
      await db.$disconnect();
      const client = new pg.Client({ connectionString: baseUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
