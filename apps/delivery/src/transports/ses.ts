// The SES fallback (PST-T-1.11, PST-REQ-045, PST-ADR-003): relay through Amazon SES's SMTP
// interface on 587 instead of the recipient's MX, for the domains that need it or for everything.
//
// It is the direct client's session with three differences: the one host is a name we configured
// (resolved through our own resolver, like every other name), STARTTLS is mandatory and the
// certificate must verify against that name, and the session authenticates before MAIL FROM. What
// it relays is the stored blob, streamed and dot-stuffed exactly as the direct client does, so the
// DKIM signature added at submission reaches SES byte for byte. The queue, retries and outcome
// classification (4xx temporary, 5xx permanent) are the worker's and do not change.
import { readFileSync } from 'node:fs';
import { isIP, isIPv4 } from 'node:net';
import type tls from 'node:tls';
import { createResolver, type Resolver } from '@postroom/dns';
import { abortReason, connectTcp, errorText, SmtpConnection, type Connector } from '../client/connection.js';
import { quitInBackground, RFC5321_TIMEOUTS, runSession, type CommandTimeouts, type Log, type SessionConfig } from '../client/session.js';
import { DEFAULT_HELO_NAME, raceAbort } from '../client/transport.js';
import type { AttemptOutcome } from '../state.js';
import type { AttemptDetails, DeliveryRequest, DeliveryResult, Transport } from './types.js';

export const SES_TRANSPORT = 'ses';
export const SES_DEFAULT_PORT = 587;

export interface SesTransportOptions {
  /** email-smtp.<region>.amazonaws.com, or a test name. */
  host: string;
  /** Default 587 (STARTTLS). */
  port?: number;
  user: string;
  password: string;
  resolver: Resolver;
  /** Recipient domains routed here ('*' = every domain). Empty = only recipients enqueued as 'ses'. */
  domains?: readonly string[];
  heloName?: string;
  connectTimeoutMs?: number;
  timeouts?: Partial<CommandTimeouts>;
  /** Extra TLS options (a test CA). Certificate verification cannot be turned off. */
  tlsOptions?: tls.ConnectionOptions;
  localAddress?: string;
  /** Addresses of the SES host to try per attempt. Default 3. */
  maxAddresses?: number;
  connect?: Connector;
  log?: Log;
}

export interface SesTransport extends Transport {
  readonly host: string;
  readonly port: number;
}

const stderrLog: Log = (event, fields) => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: 'ses-transport', event, ...fields })}\n`);
};

/** Parse DELIVERY_SES_DOMAINS: comma or space separated, lowercased, trailing dot dropped; '*' = all. */
export function parseSesDomains(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/\.$/, '')).filter((d) => d !== ''))];
}

/** Whether `domain` is routed to SES by the list (exact match, or '*'). */
export function sesClaims(domains: readonly string[], domain: string): boolean {
  if (domains.includes('*')) return true;
  return domains.includes(domain.toLowerCase().replace(/\.$/, ''));
}

function everyone(request: DeliveryRequest, outcome: AttemptOutcome): Record<string, AttemptOutcome> {
  return Object.fromEntries(request.recipients.map((r) => [r.id, outcome]));
}

export function createSesTransport(options: SesTransportOptions): SesTransport {
  const host = options.host.trim().replace(/\.$/, '').toLowerCase();
  const port = options.port ?? SES_DEFAULT_PORT;
  const connect = options.connect ?? connectTcp;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const maxAddresses = options.maxAddresses ?? 3;
  const log = options.log ?? stderrLog;
  const domains = [...(options.domains ?? [])];
  const cfg: SessionConfig = {
    heloName: options.heloName ?? DEFAULT_HELO_NAME,
    timeouts: { ...RFC5321_TIMEOUTS, ...options.timeouts },
    tlsOptions: options.tlsOptions ?? {},
    log,
    smarthost: { user: options.user, password: options.password },
  };

  const addresses = async (signal: AbortSignal): Promise<string[]> => {
    if (isIP(host) !== 0) return [host];
    const result = await raceAbort(options.resolver.a(host), signal);
    return result.answers.flatMap((rr) => (rr.kind === 'A' && isIPv4(rr.address) ? [rr.address] : []));
  };

  const deliver = async (request: DeliveryRequest): Promise<DeliveryResult> => {
    const { signal } = request;
    // A function, not the property: the loop below awaits, and the signal can fire in between.
    const aborted = (): boolean => signal.aborted;
    let details: AttemptDetails = { mxHost: host };
    if (signal.aborted) return { details, results: everyone(request, { kind: 'error', error: `aborted: ${abortReason(signal)}` }) };

    let ips: string[];
    try {
      ips = await addresses(signal);
    } catch (error) {
      const text = `resolving SES host ${host}: ${errorText(error)}`;
      log('ses-resolve-failed', { domain: request.domain, host, error: text });
      return { details, results: everyone(request, { kind: 'error', error: text }) };
    }
    if (ips.length === 0) return { details, results: everyone(request, { kind: 'error', error: `no IPv4 address for SES host ${host}` }) };

    let last: AttemptOutcome = { kind: 'error', error: 'no SES address tried' };
    for (const ip of ips.slice(0, maxAddresses)) {
      if (aborted()) {
        last = { kind: 'error', error: `aborted: ${abortReason(signal)}` };
        break;
      }
      details = { mxHost: host, mxIp: ip };
      let conn: SmtpConnection;
      try {
        const socket = await connect({ host: ip, port, ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }), timeoutMs: connectTimeoutMs, signal });
        conn = new SmtpConnection(socket, signal);
      } catch (error) {
        last = { kind: 'error', error: `${host} [${ip}] ${errorText(error)}` };
        log('ses-connect-failed', { domain: request.domain, host, ip, error: errorText(error) });
        continue;
      }
      if (conn.localAddress !== undefined) details.localIp = conn.localAddress;
      const target = { host, ip };
      const session = await runSession(conn, target, request, cfg, details);
      quitInBackground(conn, cfg, { domain: request.domain, host, ip, transport: SES_TRANSPORT });
      if (session.kind === 'definitive') {
        return { details, results: { ...everyone(request, { kind: 'error', error: 'no outcome recorded' }), ...session.results } };
      }
      last = session.outcome;
      log('ses-attempt-failed', { domain: request.domain, host, ip, outcome: last });
    }
    return { details, results: everyone(request, last) };
  };

  return {
    name: SES_TRANSPORT,
    host,
    port,
    claims: (domain: string) => sesClaims(domains, domain),
    deliver,
  };
}

/** A secret from `NAME`, or from the file named by `NAME_FILE` (trailing newline dropped). */
function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  const file = env[`${name}_FILE`];
  if (file === undefined || file === '') return undefined;
  const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  return value === '' ? undefined : value;
}

export interface SesConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  domains: string[];
}

/**
 * The SES configuration from the environment, or why there is none. Never includes a secret in
 * `missing`, only the names of the variables that were not set.
 *
 *   SES_SMTP_HOST                    the endpoint; or SES_REGION, which gives email-smtp.<region>.amazonaws.com
 *   SES_SMTP_PORT                    default 587
 *   SES_SMTP_USER[_FILE]             SES SMTP credentials (not the IAM access key)
 *   SES_SMTP_PASSWORD[_FILE]
 *   DELIVERY_SES_DOMAINS             recipient domains relayed through SES, comma separated; '*' = all
 */
export function sesConfigFromEnv(env: NodeJS.ProcessEnv): { config: SesConfig } | { config: null; missing: string[]; domains: string[] } {
  const region = env['SES_REGION']?.trim();
  const explicit = env['SES_SMTP_HOST']?.trim();
  const host = explicit !== undefined && explicit !== '' ? explicit : (region !== undefined && region !== '' ? `email-smtp.${region}.amazonaws.com` : undefined);
  const user = secret(env, 'SES_SMTP_USER');
  const password = secret(env, 'SES_SMTP_PASSWORD');
  const domains = parseSesDomains(env['DELIVERY_SES_DOMAINS']);
  const portText = env['SES_SMTP_PORT']?.trim();
  const port = portText === undefined || portText === '' ? SES_DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SES_SMTP_PORT is not a port: ${String(portText)}`);
  const missing: string[] = [];
  if (host === undefined) missing.push('SES_SMTP_HOST or SES_REGION');
  if (user === undefined) missing.push('SES_SMTP_USER');
  if (password === undefined) missing.push('SES_SMTP_PASSWORD');
  if (host === undefined || user === undefined || password === undefined) return { config: null, missing, domains };
  return { config: { host, port, user, password, domains } };
}

/**
 * The SES transport the daemon runs, or undefined when it is not configured. Logs once, at start,
 * what was decided, and never the credential. Without credentials SES is not selectable: the
 * worker routes every recipient (even one enqueued as 'ses') direct.
 */
export function sesTransportFromEnv(env: NodeJS.ProcessEnv, log: Log = stderrLog): SesTransport | undefined {
  const parsed = sesConfigFromEnv(env);
  if (parsed.config === null) {
    if (parsed.domains.length > 0) {
      log('ses-disabled', { reason: 'SES is not configured; these domains are delivered direct instead', domains: parsed.domains, missing: parsed.missing });
    }
    return undefined;
  }
  const { host, port, user, password, domains } = parsed.config;
  const localAddress = env['DELIVERY_LOCAL_ADDRESS'];
  const transport = createSesTransport({
    host,
    port,
    user,
    password,
    domains,
    resolver: createResolver({ server: env['DNS_RESOLVER'] ?? '127.0.0.1:53' }),
    heloName: env['MX_HOSTNAME'] ?? DEFAULT_HELO_NAME,
    ...(localAddress === undefined || localAddress === '' ? {} : { localAddress }),
    log,
  });
  log('ses-enabled', { host: transport.host, port: transport.port, domains: domains.length === 0 ? 'none (only recipients enqueued as ses)' : domains, user: '[redacted]' });
  return transport;
}
