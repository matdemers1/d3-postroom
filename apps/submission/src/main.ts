// Authenticated submission on 587 (STARTTLS) and 465 (implicit TLS) — PST-T-1.2.
//
// Reachable directly on the LAN and the tailnet, and — once the security gate passes and the edge
// goes live (PST-T-4.5) — through the edge, which forwards 465 and 587 over WireGuard with a PROXY v2
// header on every connection. From EDGE_PEER_ADDRESS that header is required (read before the TLS
// handshake on 465) and its source is the client; from anyone else a PROXY header closes the
// connection (PST-REQ-016, PST-T-4.17).
//
// Environment: DATABASE_URL, POSTROOM_KEK, PASSWORD_PEPPER, BLOB_ROOT, TLS_CERT_FILE, TLS_KEY_FILE,
// SUBMISSION_HOSTNAME, SUBMISSION_PORT (587), SUBMISSIONS_PORT (465), SUBMISSION_MAX_SIZE (100 MB),
// SUBMISSION_MAX_RECIPIENTS (100), SUBMISSION_CAP_HOURLY (100) / SUBMISSION_CAP_DAILY (500) per app
// password, ACCOUNT_CAP_HOURLY (200) / ACCOUNT_CAP_DAILY (1000) per account across every sending path
// (PST-T-11.11 — the api and worker read the same two), EDGE_PEER_ADDRESS (10.77.0.1, comma list),
// PROXY_TIMEOUT_MS (5000), LISTEN_HOST, HEALTH_PORT.
import type { Server } from 'node:net';
import { createAlertSender } from '@postroom/alerts';
import { createBlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { createDb } from '@postroom/db';
import { tlsHealth, watchTlsPair } from '@postroom/smtp-proto';
import { accountCapFromEnv, createCapsChecker, createCapsEnforcer } from './caps/index.js';
import { DAEMON } from './daemon.js';
import { proxyConfigFromEnv } from './proxy.js';
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
    // loudly, and say so on /health. The pair is watched (PST-REQ-020, PST-T-11.13): a renewal, or a
    // first issuance after boot, is served without a restart.
    const tls = watchTlsPair({
      certFile: envString(ctx.env, 'TLS_CERT_FILE', ''),
      keyFile: envString(ctx.env, 'TLS_KEY_FILE', ''),
      log: ctx.log,
    });

    let storage: SubmissionStorage | undefined;
    const capsOptions = {
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
    };
    const proxy = proxyConfigFromEnv(ctx.env);
    const checkCaps = createCapsChecker(capsOptions);
    const enforceCaps = createCapsEnforcer(capsOptions);
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
      enforceCaps,
      accountCap: accountCapFromEnv(ctx.env, { sendAlert: capsOptions.sendAlert, log: ctx.log }),
      edgePeers: proxy.edgePeers,
      proxyTimeoutMs: proxy.proxyTimeoutMs,
      log: ctx.log,
    });

    const port587 = envInt(ctx.env, 'SUBMISSION_PORT', 587);
    await listen(listeners.submission, port587, host);
    const port465 = envInt(ctx.env, 'SUBMISSIONS_PORT', 465);
    if (listeners.submissions !== null) await listen(listeners.submissions, port465, host);

    ctx.addHealth(() => ({ ...tlsHealth(tls), listening: listeners.submissions === null ? [port587] : [port587, port465] }));
    ctx.log('listening', { host, submission: port587, submissions: listeners.submissions === null ? null : port465, edgePeers: proxy.edgePeers });
    ctx.onShutdown(async () => {
      tls.close();
      await listeners.close();
      await db.$disconnect();
    });
  },
});
