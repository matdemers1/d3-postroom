// Backup configuration from the environment (PST-T-0.16). Unconfigured is a state, not an error:
// the job still takes its local dump, and says loudly on /health that nothing left the machine.
import { envInt, envString } from '@postroom/daemon';
import type { S3Config } from './s3.js';

export interface BackupConfig {
  /** Null when BACKUP_BUCKET (or a credential it needs) is missing; `missing` says which. */
  s3: S3Config | null;
  missing: string[];
  /** Local dump copies, kept `keepLocalDays` days; the drill falls back to them. */
  backupDir: string;
  keepLocalDays: number;
  blobRoot: string;
  /** Seals the KEK recovery bundle (PST-REQ-011). Unset → no bundle is written. */
  kekPassphrase: string | null;
}

export function backupConfig(env: NodeJS.ProcessEnv): BackupConfig {
  const bucket = envString(env, 'BACKUP_BUCKET', '');
  const required = {
    BACKUP_KMS_KEY_ID: envString(env, 'BACKUP_KMS_KEY_ID', ''),
    AWS_ACCESS_KEY_ID: envString(env, 'AWS_ACCESS_KEY_ID', ''),
    AWS_SECRET_ACCESS_KEY: envString(env, 'AWS_SECRET_ACCESS_KEY', ''),
  };
  const missing = bucket === '' ? ['BACKUP_BUCKET'] : Object.entries(required).filter(([, v]) => v === '').map(([k]) => k);
  const endpoint = envString(env, 'BACKUP_S3_ENDPOINT', '');
  const sessionToken = envString(env, 'AWS_SESSION_TOKEN', '');
  const passphrase = env['BACKUP_KEK_PASSPHRASE'] ?? '';
  return {
    s3: missing.length > 0
      ? null
      : {
          bucket,
          region: envString(env, 'AWS_REGION', 'us-east-1'),
          kmsKeyId: required.BACKUP_KMS_KEY_ID,
          credentials: {
            accessKeyId: required.AWS_ACCESS_KEY_ID,
            secretAccessKey: required.AWS_SECRET_ACCESS_KEY,
            ...(sessionToken === '' ? {} : { sessionToken }),
          },
          ...(endpoint === '' ? {} : { endpoint }),
        },
    missing,
    backupDir: envString(env, 'BACKUP_DIR', '/var/lib/postroom/backups'),
    keepLocalDays: envInt(env, 'BACKUP_KEEP_LOCAL_DAYS', 7),
    blobRoot: envString(env, 'BLOB_ROOT', envString(env, 'BLOB_DIR', '/var/lib/postroom/blobs')),
    kekPassphrase: passphrase === '' ? null : passphrase,
  };
}
