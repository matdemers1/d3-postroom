// The ACME DNS-01 certificate job (PST-T-0.15, PST-REQ-020, PST-ADR-010).
//
//   1. Decide: the live pair at <certDir>/<domain>/ is renewed when it is missing, its key does not
//      match, it does not cover ACME_DOMAINS, or it has fewer than ACME_RENEW_DAYS left.
//   2. Take the lease (the daemon's timer and `postroom acme` never overlap).
//   3. The first production run is preceded by a staging run into <certDir>/staging/, recorded as
//      the gate: Let's Encrypt production is never contacted before staging has succeeded.
//   4. Account (ES256, sealed in the DB) → order → for each authorization: find the dns-01
//      challenge, follow _acme-challenge.<domain>'s CNAME into the challenge zone (refusing any
//      other target), create the TXT through Cloudflare, wait for every authoritative nameserver
//      to serve it, respond, poll — and ALWAYS delete the TXT afterwards.
//   5. A fresh RSA-2048 key and a hand-built CSR → finalize → poll → download the chain, checked
//      against the key and the domains before it is written atomically for the daemons to reload.
//   6. Audit (system actor), record, and on failure back off and alert through the D3 Auth relay.
import { randomBytes, type KeyObject } from 'node:crypto';
import type { SendAlert } from '@postroom/alerts';
import { AcmeClient, type AcmeAuthorization, type Log } from './client.js';
import type { DnsApi } from './cloudflare.js';
import { certPaths, type AcmeConfig } from './config.js';
import { buildCsr, generateCertificateKey } from './csr.js';
import { resolveChallengeTarget, waitForTxt, type ChallengeDns } from './dns.js';
import { installPair, leafOf, readExisting, renewalReason, sanDomains } from './files.js';
import { dns01TxtValue, generateAccountKey, keyAuthorization } from './jws.js';
import type { AcmeStore, LastAcme } from './state.js';

export interface AcmeDeps {
  readonly config: AcmeConfig;
  readonly store: AcmeStore;
  readonly dns: ChallengeDns;
  readonly dnsApi: DnsApi;
  readonly sendAlert: SendAlert;
  readonly fetch?: typeof fetch;
  readonly log?: Log;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Who holds the lease (process + random). */
  readonly holder?: string;
  readonly userAgent?: string;
  /** How often the authoritative servers are asked for the TXT. */
  readonly dnsPollMs?: number;
  readonly pollTimeoutMs?: number;
  /** Certificate key type; RSA-2048 unless a test asks otherwise. */
  readonly certKeyType?: 'rsa' | 'ec';
}

export interface AcmeRunOptions {
  /** Issue even when the current certificate is fine, and ignore the failure back-off. */
  readonly force?: boolean;
  /** Run against the staging directory into <certDir>/staging/ (the live pair is untouched). */
  readonly staging?: boolean;
}

export interface AcmeRunResult {
  readonly ok: boolean;
  readonly action: 'issued' | 'renewed' | 'not-due' | 'disabled' | 'busy' | 'backoff' | 'failed';
  readonly directory?: string;
  readonly domains?: readonly string[];
  readonly certFile?: string;
  readonly keyFile?: string;
  readonly notAfter?: string;
  readonly daysLeft?: number;
  readonly reason?: string;
  /** The staging gate run that preceded this production run, when one did. */
  readonly stagingGate?: { readonly notAfter: string };
}

/** Alert once a failing renewal leaves fewer than this many days. */
export const URGENT_DAYS = 14;
const LEASE_MS = 30 * 60_000;

/** After n consecutive failures, wait 1 h, 3 h, 6 h, 12 h, then a day: a few tries a day at most. */
export function failureBackoffMs(failures: number): number {
  const hours = [1, 3, 6, 12, 24];
  return (hours[Math.min(Math.max(failures, 1), hours.length) - 1] ?? 24) * 3_600_000;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Issued {
  readonly certPem: string;
  readonly keyPem: string;
  readonly notAfter: Date;
  readonly serial: string;
}

/** Hold a TXT at `name` for the duration of `fn`, and delete it afterwards whatever happens. */
export async function withTxt<T>(api: DnsApi, name: string, value: string, log: Log, fn: () => Promise<T>): Promise<T> {
  // A crashed earlier run may have left a record at this name; the name exists only for this.
  for (const stale of await api.listTxt(name)) {
    await api.deleteRecord(stale.id);
    log('acme-txt-stale-deleted', { name });
  }
  const id = await api.createTxt(name, value);
  log('acme-txt-created', { name });
  try {
    return await fn();
  } finally {
    try {
      await api.deleteRecord(id);
      log('acme-txt-deleted', { name });
    } catch (error) {
      // Never masks fn's own error; the next run's stale sweep removes it.
      log('acme-txt-delete-failed', { name, error: errorText(error) });
    }
  }
}

async function accountKey(store: AcmeStore, log: Log): Promise<KeyObject> {
  const existing = await store.loadAccountKey();
  if (existing !== null) return existing;
  const key = generateAccountKey();
  await store.saveAccountKey(key);
  log('acme-account-key-created');
  return key;
}

async function authorize(deps: AcmeDeps, client: AcmeClient, url: string, log: Log, now: () => Date, sleep: (ms: number) => Promise<void>): Promise<void> {
  const authz: AcmeAuthorization = await client.getAuthorization(url);
  const domain = authz.identifier.value;
  if (authz.status === 'valid') {
    log('acme-authz-reused', { domain });
    return;
  }
  if (authz.status !== 'pending') throw new Error(`authorization for ${domain} is ${authz.status}`);
  const challenge = authz.challenges.find((c) => c.type === 'dns-01');
  if (challenge === undefined) throw new Error(`the CA offered no dns-01 challenge for ${domain}`);
  // Refuses before anything is written: the TXT only ever goes inside the challenge zone.
  const name = await resolveChallengeTarget(deps.dns, domain, deps.config.challengeZone);
  const value = dns01TxtValue(keyAuthorization(challenge.token, client.accountJwk));
  await withTxt(deps.dnsApi, name, value, log, async () => {
    const seen = await waitForTxt(deps.dns, {
      zone: deps.config.challengeZone,
      name,
      value,
      timeoutMs: deps.config.dnsWaitMs,
      intervalMs: deps.dnsPollMs ?? 5_000,
      sleep,
      now: () => now().getTime(),
    });
    log('acme-txt-visible', { name, servers: seen.servers, checks: seen.checks });
    await client.respondChallenge(challenge.url);
    const done = await client.pollAuthorization(url);
    if (done.status !== 'valid') {
      const failed = done.challenges.find((c) => c.type === 'dns-01');
      throw new Error(`authorization for ${domain} is ${done.status}${failed?.error?.detail === undefined ? '' : `: ${failed.error.detail}`}`);
    }
    log('acme-authz-valid', { domain });
  });
}

/** One full issuance against `directoryUrl`. Writes nothing to disk. */
async function issue(deps: AcmeDeps, directoryUrl: string, key: KeyObject, log: Log): Promise<Issued> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const { domains } = deps.config;
  const client = new AcmeClient({
    directoryUrl,
    accountKey: key,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    log,
    sleep,
    now: () => now().getTime(),
    ...(deps.userAgent === undefined ? {} : { userAgent: deps.userAgent }),
    ...(deps.pollTimeoutMs === undefined ? {} : { pollTimeoutMs: deps.pollTimeoutMs }),
  });
  await client.account(deps.config.contact);
  const { url: orderUrl, order } = await client.newOrder(domains);
  if (order.status === 'invalid') throw new Error('the new order is already invalid');
  // One at a time: with one or two domains the gain from parallelism is nil, and a failure leaves
  // exactly one TXT to clean up.
  for (const authzUrl of order.authorizations) await authorize(deps, client, authzUrl, log, now, sleep);

  let current = await client.pollOrder(orderUrl, ['ready', 'valid']);
  if (current.status === 'invalid') throw new Error(`the order became invalid${current.error?.detail === undefined ? '' : `: ${current.error.detail}`}`);
  const certKey = generateCertificateKey(deps.certKeyType ?? 'rsa');
  if (current.status === 'ready') {
    current = await client.finalize(current.finalize, buildCsr(certKey, domains));
    log('acme-finalized', { status: current.status });
  }
  if (current.status !== 'valid') current = await client.pollOrder(orderUrl, ['valid']);
  if (current.status !== 'valid' || current.certificate === undefined) {
    throw new Error(`the order ended ${current.status}${current.error?.detail === undefined ? '' : `: ${current.error.detail}`}`);
  }
  const certPem = await client.downloadCertificate(current.certificate);
  const leaf = leafOf(certPem);
  // What is written must be what the daemons will accept: the key matches and every name is there.
  if (!leaf.checkPrivateKey(certKey)) throw new Error('the issued certificate does not match the generated key');
  const covered = sanDomains(leaf);
  const missing = domains.filter((d) => !covered.includes(d));
  if (missing.length > 0) throw new Error(`the issued certificate does not cover ${missing.join(', ')}`);
  const keyPem = certKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { certPem, keyPem, notAfter: new Date(leaf.validTo), serial: leaf.serialNumber };
}

async function alertFailure(deps: AcmeDeps, reason: string, failures: number, daysLeft: number | null, nextAttemptAt: string): Promise<void> {
  const urgent = daysLeft !== null && daysLeft < URGENT_DAYS;
  const domains = deps.config.domains.join(', ');
  await deps.sendAlert({
    key: urgent ? 'acme-renewal-failing-urgent' : 'acme-renewal-failed',
    subject: urgent
      ? `Postroom: TLS certificate for ${domains} expires in ${daysLeft.toFixed(1)} days and renewal keeps failing`
      : `Postroom: TLS certificate renewal failed for ${domains}`,
    text: [
      `The ACME DNS-01 job could not obtain a certificate for ${domains} (PST-REQ-020).`,
      '',
      `Reason: ${reason}`,
      `Consecutive failures: ${String(failures)}`,
      `Current certificate: ${daysLeft === null ? 'none' : `${daysLeft.toFixed(1)} days left`}`,
      `Next automatic attempt: ${nextAttemptAt}`,
      '',
      'See docs/runbooks/acme.md. `postroom acme --force` retries now.',
    ].join('\n'),
  });
}

/** Run the job once. Never throws: every outcome is a result (and failures are recorded and alerted). */
export async function runAcme(deps: AcmeDeps, opts: AcmeRunOptions = {}): Promise<AcmeRunResult> {
  const { config, store } = deps;
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => new Date());
  if (!config.enabled) return { ok: false, action: 'disabled', reason: `ACME is off (${config.missing.join(', ')} not set)` };

  const staging = opts.staging === true;
  const directory = staging ? (config.stagingDirectoryUrl ?? config.directoryUrl) : config.directoryUrl;
  const paths = certPaths(config.certDir, config.domains, staging);
  const base = { directory, domains: config.domains, certFile: paths.cert, keyFile: paths.key };

  let existing: Awaited<ReturnType<typeof readExisting>> = null;
  try {
    existing = await readExisting(paths.cert, paths.key, now());
  } catch (error) {
    log('acme-existing-unreadable', { error: errorText(error) });
  }
  const due = renewalReason(existing, config.domains, config.renewDays);
  if (due === null && opts.force !== true) {
    return { ok: true, action: 'not-due', ...base, ...(existing === null ? {} : { notAfter: existing.notAfter.toISOString(), daysLeft: existing.daysLeft }) };
  }

  const last = staging ? null : await store.readLast();
  if (!staging && opts.force !== true && last?.nextAttemptAt !== undefined && new Date(last.nextAttemptAt).getTime() > now().getTime()) {
    return { ok: false, action: 'backoff', ...base, reason: `backing off until ${last.nextAttemptAt} after ${String(last.consecutiveFailures)} failure(s): ${last.reason ?? ''}` };
  }

  const holder = deps.holder ?? `${String(process.pid)}-${randomBytes(4).toString('hex')}`;
  if (!(await store.acquire(holder, LEASE_MS, now()))) return { ok: false, action: 'busy', ...base, reason: 'another ACME run holds the lease' };
  const reason = due ?? 'forced';
  log('acme-run', { directory, domains: config.domains, staging, reason });
  let stagingGate: { notAfter: string } | undefined;
  try {
    const missingConfig = config.missing.filter((m) => m === 'ACME_CHALLENGE_ZONE' || m === 'ACME_CHALLENGE_ZONE_ID');
    if (missingConfig.length > 0) throw new Error(`${missingConfig.join(', ')} not set`);
    const key = await accountKey(store, log);

    if (!staging && config.stagingDirectoryUrl !== null && (await store.readStaging()) === null) {
      log('acme-staging-gate', { directory: config.stagingDirectoryUrl });
      const trial = await issue(deps, config.stagingDirectoryUrl, key, log);
      await installPair(certPaths(config.certDir, config.domains, true), trial);
      await store.recordStaging({ at: now().toISOString(), directory: config.stagingDirectoryUrl, domains: config.domains, notAfter: trial.notAfter.toISOString() });
      await store.audit({ action: 'tls.certificate.issue', entityId: config.domains[0] ?? '', after: { staging: true, directory: config.stagingDirectoryUrl, domains: config.domains, notAfter: trial.notAfter.toISOString(), serial: trial.serial } });
      stagingGate = { notAfter: trial.notAfter.toISOString() };
    }

    const issued = await issue(deps, directory, key, log);
    await installPair(paths, issued);
    const action = existing === null ? 'issued' : 'renewed';
    await store.audit({
      action: action === 'issued' ? 'tls.certificate.issue' : 'tls.certificate.renew',
      entityId: config.domains[0] ?? '',
      before: existing === null ? null : { notAfter: existing.notAfter.toISOString(), serial: existing.serial, domains: existing.domains },
      after: { staging, directory, domains: config.domains, notAfter: issued.notAfter.toISOString(), serial: issued.serial, reason, certFile: paths.cert },
    });
    const notAfter = issued.notAfter.toISOString();
    if (staging) {
      await store.recordStaging({ at: now().toISOString(), directory, domains: config.domains, notAfter });
    } else {
      await store.recordLast({ at: now().toISOString(), ok: true, action, directory, domains: config.domains, notAfter, serial: issued.serial, consecutiveFailures: 0 });
    }
    log('acme-installed', { action, staging, notAfter, certFile: paths.cert });
    return { ok: true, action, ...base, notAfter, daysLeft: (issued.notAfter.getTime() - now().getTime()) / 86_400_000, ...(stagingGate === undefined ? {} : { stagingGate }) };
  } catch (error) {
    const why = errorText(error);
    log('acme-failed', { staging, error: why });
    if (!staging) {
      const failures = (last?.consecutiveFailures ?? 0) + 1;
      const nextAttemptAt = new Date(now().getTime() + failureBackoffMs(failures)).toISOString();
      const record: LastAcme = { at: now().toISOString(), ok: false, action: 'failed', directory, domains: config.domains, reason: why, consecutiveFailures: failures, nextAttemptAt };
      try {
        await store.recordLast(record);
      } catch (recordError) {
        log('acme-record-failed', { error: errorText(recordError) });
      }
      await alertFailure(deps, why, failures, existing?.daysLeft ?? null, nextAttemptAt);
    }
    return { ok: false, action: 'failed', ...base, reason: why, ...(stagingGate === undefined ? {} : { stagingGate }) };
  } finally {
    try {
      await store.release(holder);
    } catch (error) {
      log('acme-release-failed', { error: errorText(error) });
    }
  }
}
