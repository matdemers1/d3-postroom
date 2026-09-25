// Authenticated submission on 587 (STARTTLS) and 465 (implicit TLS) — PST-T-1.2.
//
// Reachable on the LAN and the tailnet only until the security gate passes: the edge's Lightsail
// firewall keeps 465/587 closed and the edge does not forward them (PST-REQ-026) — that is the
// edge's configuration, not this daemon's.
//
// Environment: DATABASE_URL, POSTROOM_KEK, PASSWORD_PEPPER, BLOB_ROOT, TLS_CERT_FILE, TLS_KEY_FILE,
// SUBMISSION_HOSTNAME, SUBMISSION_PORT (587), SUBMISSIONS_PORT (465), SUBMISSION_MAX_SIZE (100 MB),
// SUBMISSION_MAX_RECIPIENTS (100), LISTEN_HOST, HEALTH_PORT.
import { readFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { createAlertSender } from '@postroom/alerts';
import { createBlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { createCapsChecker } from './caps/index.js';
import { DAEMON } from './daemon.js';
import { createSubmissionListeners, type SubmissionStorage } from './server.js';

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9102),
  start: async (ctx) => {
    const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
    if (databaseUrl === '') throw new Error('DATABASE_URL is required');
    const db = createDb(databaseUrl);
    const host = envString(ctx.env, 'LISTEN_HOST', '0.0.0.0');
    const blobRoot = envString(ctx.env, 'BLOB_ROOT', '/var/lib/postroom/blobs');
    const pepper = envString(ctx.env, 'PASSWORD_PEPPER', '');
    if (pepper === '') ctx.log('no-pepper', { message: 'PASSWORD_PEPPER is not set: every AUTH will be refused' });

    // TLS is required before AUTH, so without a certificate nothing can be submitted: fail closed,
    // loudly, and say so on /health.
    const certFile = envString(ctx.env, 'TLS_CERT_FILE', '');
    const keyFile = envString(ctx.env, 'TLS_KEY_FILE', '');
    let tls: { key: Buffer; cert: Buffer } | null = null;
    if (certFile === '' || keyFile === '') {
      ctx.log('no-tls-certificate', { message: 'TLS_CERT_FILE/TLS_KEY_FILE not set: no STARTTLS, no 465, no AUTH, nothing can be submitted' });
    } else {
      try {
        tls = { key: readFileSync(keyFile), cert: readFileSync(certFile) };
      } catch (error) {
        ctx.log('no-tls-certificate', {
          message: 'cannot read the TLS certificate: no STARTTLS, no 465, no AUTH, nothing can be submitted',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let storage: SubmissionStorage | undefined;
    const checkCaps = createCapsChecker({
      db,
      hourlyDefault: envInt(ctx.env, 'SUBMISSION_CAP_HOURLY', 100),
      dailyDefault: envInt(ctx.env, 'SUBMISSION_CAP_DAILY', 500),
      sendAlert: createAlertSender(
        {
          url: envString(ctx.env, 'MAIL_RELAY_URL', ''),
          token: envString(ctx.env, 'MAIL_RELAY_TOKEN', ''),
          to: envString(ctx.env, 'ALERT_TO', ''),
        },
        { log: ctx.log },
      ),
      log: ctx.log,
    });
    const listeners = createSubmissionListeners({
      db,
      hostname: envString(ctx.env, 'SUBMISSION_HOSTNAME', 'mail.d3cloud.io'),
      maxSize: envInt(ctx.env, 'SUBMISSION_MAX_SIZE', 100 * 1024 * 1024),
      maxRecipients: envInt(ctx.env, 'SUBMISSION_MAX_RECIPIENTS', 100),
      pepper: pepper === '' ? undefined : pepper,
      storage: () => {
        if (storage === undefined) {
          const kek = loadKek({ env: ctx.env });
          storage = { kek, blobs: createBlobStore({ root: blobRoot, db, kek }) };
        }
        return storage;
      },
      tls,
      checkCaps,
      log: ctx.log,
    });

    const port587 = envInt(ctx.env, 'SUBMISSION_PORT', 587);
    await listen(listeners.submission, port587, host);
    const port465 = envInt(ctx.env, 'SUBMISSIONS_PORT', 465);
    if (listeners.submissions !== null) await listen(listeners.submissions, port465, host);

    ctx.addHealth(() =>
      tls === null
        ? { status: 'degraded', tls: 'degraded: no TLS certificate', listening: [port587] }
        : { tls: 'ok', listening: [port587, port465] },
    );
    ctx.log('listening', { host, submission: port587, submissions: listeners.submissions === null ? null : port465 });
    ctx.onShutdown(async () => {
      await listeners.close();
      await db.$disconnect();
    });
  },
});
