// The ACME job's configuration (PST-T-0.15, PST-REQ-020). Off unless ACME_DNS_TOKEN and
// ACME_DOMAINS are both set, so a laptop, CI and the e2e stack never reach Let's Encrypt.
import { join } from 'node:path';
import { envInt, envString } from '@postroom/daemon';

export const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
export const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
export const DEFAULT_CERT_DIR = '/var/lib/postroom/certs';

export interface AcmeConfig {
  readonly enabled: boolean;
  /** The env names that are missing, when not enabled (or enabled but incomplete). */
  readonly missing: readonly string[];
  /** Cloudflare token scoped to the challenge zone only. Never logged. */
  readonly token: string;
  readonly challengeZone: string;
  readonly challengeZoneId: string;
  readonly domains: readonly string[];
  readonly directoryUrl: string;
  /**
   * The staging directory a production run must have succeeded against first (doneWhen: "a run
   * against Let's Encrypt staging succeeds before production is used"); null when the configured
   * directory is not Let's Encrypt production (a test server, or staging itself).
   */
  readonly stagingDirectoryUrl: string | null;
  readonly certDir: string;
  readonly renewDays: number;
  /** ACME account contact URLs (mailto:), empty unless ACME_CONTACT is set. */
  readonly contact: readonly string[];
  /** The recursive resolver for the CNAME/NS lookups; empty → the system resolver. */
  readonly dnsResolver: string;
  readonly dnsWaitMs: number;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function parseDomains(raw: string): string[] {
  const domains = raw
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/\.$/, ''))
    .filter((d) => d !== '');
  for (const d of domains) if (!HOSTNAME.test(d)) throw new Error(`ACME_DOMAINS: "${d}" is not a hostname (wildcards are not supported)`);
  return [...new Set(domains)];
}

export function acmeConfig(env: NodeJS.ProcessEnv): AcmeConfig {
  const token = envString(env, 'ACME_DNS_TOKEN', '');
  // A malformed ACME_DOMAINS turns the job off (and says why) rather than failing the whole worker.
  let domains: string[] = [];
  let invalid: string | null = null;
  try {
    domains = parseDomains(envString(env, 'ACME_DOMAINS', ''));
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  const challengeZone = envString(env, 'ACME_CHALLENGE_ZONE', '').toLowerCase().replace(/\.$/, '');
  const challengeZoneId = envString(env, 'ACME_CHALLENGE_ZONE_ID', '');
  const directoryUrl = envString(env, 'ACME_DIRECTORY_URL', LE_PRODUCTION);
  const contactRaw = envString(env, 'ACME_CONTACT', '');
  const missing = [
    ...(token === '' ? ['ACME_DNS_TOKEN'] : []),
    ...(invalid !== null ? [invalid] : domains.length === 0 ? ['ACME_DOMAINS'] : []),
    ...(challengeZone === '' ? ['ACME_CHALLENGE_ZONE'] : []),
    ...(challengeZoneId === '' ? ['ACME_CHALLENGE_ZONE_ID'] : []),
  ];
  return {
    enabled: token !== '' && domains.length > 0,
    missing,
    token,
    challengeZone,
    challengeZoneId,
    domains,
    directoryUrl,
    stagingDirectoryUrl: directoryUrl === LE_PRODUCTION ? LE_STAGING : null,
    certDir: envString(env, 'ACME_CERT_DIR', DEFAULT_CERT_DIR),
    renewDays: envInt(env, 'ACME_RENEW_DAYS', 30),
    contact: contactRaw === '' ? [] : contactRaw.split(',').map((c) => c.trim()).filter((c) => c !== '').map((c) => (c.startsWith('mailto:') ? c : `mailto:${c}`)),
    // The stack's own Unbound (DNS_RESOLVER) when set, else the system resolver.
    dnsResolver: envString(env, 'ACME_DNS_RESOLVER', envString(env, 'DNS_RESOLVER', '')),
    dnsWaitMs: envInt(env, 'ACME_DNS_WAIT_MS', 300_000),
  };
}

/**
 * Where a certificate for `domains` lives: <certDir>/<first domain>/, or <certDir>/staging/<first
 * domain>/ for a staging run — never the live path, so an untrusted staging certificate is never
 * hot-reloaded by the daemons.
 */
export function certPaths(certDir: string, domains: readonly string[], staging: boolean): { dir: string; cert: string; key: string } {
  const [first] = domains;
  if (first === undefined) throw new Error('no ACME domains');
  const dir = staging ? join(certDir, 'staging', first) : join(certDir, first);
  return { dir, cert: join(dir, 'fullchain.pem'), key: join(dir, 'privkey.pem') };
}
