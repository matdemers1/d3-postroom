// Building the backup and drill dependencies from the environment, shared by the daemon's queue
// handlers and the one-shot `postroom backup` / `postroom drill` commands.
import { loadKek, type Kek } from '@postroom/crypto';
import { revision } from '@postroom/daemon';
import type { Db } from '@postroom/db';
import { backupConfig } from './config.js';
import type { BackupDeps, Log } from './job.js';
import { commandPgTools } from './pgtools.js';

export function maintenanceDeps(env: NodeJS.ProcessEnv, db: Db, databaseUrl: string, log: Log): { backup: BackupDeps } {
  const config = backupConfig(env);
  const pg = commandPgTools();
  let kek: Kek | undefined;
  const getKek = (): Kek => (kek ??= loadKek({ env }));
  return {
    backup: { db, databaseUrl, config, pg, kek: getKek, revision: revision(env), log },
  };
}
