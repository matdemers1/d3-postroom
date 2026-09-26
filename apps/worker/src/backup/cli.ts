// `postroom backup` and `postroom drill`: run one backup or one restore drill now, outside the
// nightly schedule, and record it exactly as the scheduled run would (so /health shows it). Exits
// non-zero unless the run was green — an unconfigured backup included.
import { createDb } from '@postroom/db';
import { envString, makeLogger } from '@postroom/daemon';
import { runDrill } from '../drill/drill.js';
import { runBackup } from './job.js';
import { maintenanceDeps } from './wire.js';

export async function main(command: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (command !== 'backup' && command !== 'drill') {
    process.stderr.write('usage: postroom <backup|drill>\n');
    return 2;
  }
  const databaseUrl = envString(env, 'DATABASE_URL', '');
  if (databaseUrl === '') {
    process.stderr.write('DATABASE_URL is required\n');
    return 2;
  }
  const db = createDb(databaseUrl);
  try {
    const deps = maintenanceDeps(env, db, databaseUrl, makeLogger(`worker-${command}`));
    const result = command === 'backup' ? await runBackup(deps.backup) : await runDrill(deps.drill);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`postroom ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await db.$disconnect();
  }
}
