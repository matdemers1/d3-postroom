// `postroom acme [--staging] [--force]` (PST-T-0.15): run the certificate job once now, exactly as
// the worker's timer would, and print a JSON summary. --staging uses Let's Encrypt staging and
// writes under <certDir>/staging/, leaving the live pair alone; --force issues even when the
// current certificate is fine and ignores the failure back-off. Exits 0 only when the run was ok.
import { createDb } from '@postroom/db';
import { envString, makeLogger } from '@postroom/daemon';
import { runAcme } from './job.js';
import { acmeDeps } from './wire.js';

export const USAGE = 'usage: postroom acme [--staging] [--force]';

export function parseArgs(args: readonly string[]): { staging: boolean; force: boolean } | null {
  let staging = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--staging') staging = true;
    else if (arg === '--force') force = true;
    else return null;
  }
  return { staging, force };
}

export async function main(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const databaseUrl = envString(env, 'DATABASE_URL', '');
  if (databaseUrl === '') {
    process.stderr.write('DATABASE_URL is required\n');
    return 2;
  }
  const db = createDb(databaseUrl);
  try {
    const result = await runAcme(acmeDeps(env, db, makeLogger('worker-acme')), parsed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`postroom acme: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}
