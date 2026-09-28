// Building the ACME job's dependencies from the environment, shared by the worker daemon's timer
// and the one-shot `postroom acme` (PST-T-0.15).
import { createAlertSender } from '@postroom/alerts';
import { loadKek, type Kek } from '@postroom/crypto';
import { envString, revision } from '@postroom/daemon';
import type { Db } from '@postroom/db';
import type { Log } from './client.js';
import { cloudflareDnsApi } from './cloudflare.js';
import { acmeConfig } from './config.js';
import { nodeChallengeDns } from './dns.js';
import type { AcmeDeps } from './job.js';
import { dbAcmeStore } from './state.js';

export function acmeDeps(env: NodeJS.ProcessEnv, db: Db, log: Log): AcmeDeps {
  const config = acmeConfig(env);
  let kek: Kek | undefined;
  return {
    config,
    store: dbAcmeStore(db, () => (kek ??= loadKek({ env }))),
    dns: nodeChallengeDns({ resolver: config.dnsResolver }),
    dnsApi: cloudflareDnsApi({ token: config.token, zoneId: config.challengeZoneId }),
    sendAlert: createAlertSender(
      { url: envString(env, 'MAIL_RELAY_URL', ''), token: envString(env, 'MAIL_RELAY_TOKEN', ''), to: envString(env, 'ALERT_TO', '') },
      { log },
    ),
    log,
    userAgent: `postroom-acme/${revision(env)}`,
  };
}
