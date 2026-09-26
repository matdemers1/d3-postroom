// The direct MX transport (PST-T-1.6): resolve the recipient domain's MX through our own validating
// resolver (never the OS resolver), then try its addresses in preference order until one of them
// holds a definitive SMTP transaction.
//
//   PST-REQ-035  STARTTLS whenever offered; TLS version, cipher and peer recorded per attempt.
//   PST-REQ-036  IPv4 only until IPv6 reverse DNS exists: no AAAA is looked up or dialled while
//                `ipv4Only` is on (DELIVERY_IPV6=1 turns it off).
//   PST-REQ-019  egress through the WireGuard sidecar is the network namespace's job; the socket's
//                local address is recorded as `localIp` so an attempt shows which path it took.
import { isIP, isIPv4 } from 'node:net';
import type tls from 'node:tls';
import { DnsServfailError, resolveMxTargets, type Resolver } from '@postroom/dns';
import type { AttemptOutcome } from '../state.js';
import type { AttemptDetails, DeliveryRequest, DeliveryResult, Transport } from '../transports/types.js';
import { abortReason, connectTcp, errorText, SmtpClientError, SmtpConnection, type Connector } from './connection.js';
import { quitInBackground, RFC5321_TIMEOUTS, runSession, type CommandTimeouts, type Log, type SessionConfig, type Target } from './session.js';

export interface DirectTransportOptions {
  resolver: Resolver;
  /** Our EHLO name: MX_HOSTNAME. Default mx.d3cloud.io. */
  heloName?: string;
  /** PST-REQ-036. Default true. */
  ipv4Only?: boolean;
  /** Default 30 s. */
  connectTimeoutMs?: number;
  /** Per-command deadlines; defaults are RFC 5321 §4.5.3.2. */
  timeouts?: Partial<CommandTimeouts>;
  /** Default 25; tests point it at a loopback fake MX. */
  port?: number;
  /** Extra TLS options (a test CA, a pinned version). Defaults: opportunistic, TLS ≥ 1.2, SNI = MX host. */
  tlsOptions?: tls.ConnectionOptions;
  /** Bind the source address. Normally unset: the netns routes port 25 through the tunnel. */
  localAddress?: string;
  /** RFC 5321 §4.5.4.1: at most this many addresses per attempt. Default 5. */
  maxAddresses?: number;
  /** Deterministic MX tie-breaks in tests. */
  random?: () => number;
  /** Injectable connector for tests; default dials TCP. */
  connect?: Connector;
  name?: string;
  log?: Log;
}

export const DEFAULT_HELO_NAME = 'mx.d3cloud.io';

const stderrLog: Log = (event, fields) => {
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), component: 'direct-transport', event, ...fields })}\n`);
};

function everyone(request: DeliveryRequest, outcome: AttemptOutcome): Record<string, AttemptOutcome> {
  return Object.fromEntries(request.recipients.map((r) => [r.id, outcome]));
}

/** Resolve `promise`, or reject as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SmtpClientError('aborted', 'connect', abortReason(signal)));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(new SmtpClientError('aborted', 'connect', abortReason(signal))); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

export function createDirectTransport(options: DirectTransportOptions): Transport {
  const ipv4Only = options.ipv4Only ?? true;
  const port = options.port ?? 25;
  const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
  const maxAddresses = options.maxAddresses ?? 5;
  const connect = options.connect ?? connectTcp;
  const log = options.log ?? stderrLog;
  const cfg: SessionConfig = {
    heloName: options.heloName ?? DEFAULT_HELO_NAME,
    timeouts: { ...RFC5321_TIMEOUTS, ...options.timeouts },
    tlsOptions: options.tlsOptions ?? {},
    log,
  };

  const deliver = async (request: DeliveryRequest): Promise<DeliveryResult> => {
    const { signal } = request;
    // A function, not the property: the loop below awaits, and the signal can fire in between.
    const aborted = (): boolean => signal.aborted;
    let details: AttemptDetails = {};
    if (signal.aborted) return { details, results: everyone(request, { kind: 'error', error: `aborted: ${abortReason(signal)}` }) };

    let resolution: Awaited<ReturnType<typeof resolveMxTargets>>;
    try {
      resolution = await raceAbort(
        resolveMxTargets(options.resolver, request.domain, { ipv4Only, ...(options.random === undefined ? {} : { rng: options.random }) }),
        signal,
      );
    } catch (error) {
      const text = error instanceof DnsServfailError ? `DNS SERVFAIL resolving MX for ${request.domain}: ${error.message}` : `resolving MX for ${request.domain}: ${errorText(error)}`;
      log('mx-resolve-failed', { domain: request.domain, error: text });
      return { details, results: everyone(request, { kind: 'error', error: text }) };
    }

    if (resolution.kind === 'null-mx') {
      return { details, results: everyone(request, { kind: 'permanent', code: 556, enhanced: '5.1.10', text: `${request.domain} does not accept mail (null MX)` }) };
    }
    if (resolution.kind === 'permanent') {
      if (resolution.reason === 'nxdomain' || resolution.reason === 'no-mx-no-address') {
        const why = resolution.reason === 'nxdomain' ? 'does not exist' : 'has no MX and no address';
        return { details, results: everyone(request, { kind: 'permanent', code: 550, enhanced: '5.1.2', text: `${request.domain} ${why}` }) };
      }
      // Anything else (REFUSED from our own resolver, …) is our problem, not the recipient's.
      return { details, results: everyone(request, { kind: 'error', error: `resolving MX for ${request.domain}: ${resolution.reason}` }) };
    }

    const candidates: Target[] = [];
    for (const target of resolution.targets) {
      for (const ip of target.addresses) {
        // Belt and braces for PST-REQ-036: the resolver was told ipv4Only, and nothing else is dialled either.
        if (ipv4Only ? !isIPv4(ip) : isIP(ip) === 0) continue;
        candidates.push({ host: target.host, ip });
      }
    }
    if (candidates.length === 0) {
      return { details, results: everyone(request, { kind: 'error', error: `no ${ipv4Only ? 'IPv4 ' : ''}address for any MX of ${request.domain}` }) };
    }

    let last: AttemptOutcome = { kind: 'error', error: 'no MX tried' };
    for (const target of candidates.slice(0, maxAddresses)) {
      if (aborted()) {
        last = { kind: 'error', error: `aborted: ${abortReason(signal)}` };
        break;
      }
      details = { mxHost: target.host, mxIp: target.ip };
      let conn: SmtpConnection;
      try {
        const socket = await connect({ host: target.ip, port, ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }), timeoutMs: connectTimeoutMs, signal });
        conn = new SmtpConnection(socket, signal);
      } catch (error) {
        last = { kind: 'error', error: `${target.host} [${target.ip}] ${errorText(error)}` };
        log('mx-connect-failed', { domain: request.domain, mxHost: target.host, mxIp: target.ip, error: errorText(error) });
        continue;
      }
      if (conn.localAddress !== undefined) details.localIp = conn.localAddress;
      log('mx-connected', { domain: request.domain, mxHost: target.host, mxIp: target.ip, localIp: conn.localAddress });

      const session = await runSession(conn, target, request, cfg, details);
      quitInBackground(conn, cfg, { domain: request.domain, mxHost: target.host, mxIp: target.ip });
      if (session.kind === 'definitive') {
        return { details, results: { ...everyone(request, { kind: 'error', error: 'no outcome recorded' }), ...session.results } };
      }
      last = session.outcome;
      log('mx-attempt-failed', { domain: request.domain, mxHost: target.host, mxIp: target.ip, outcome: last });
    }
    return { details, results: everyone(request, last) };
  };

  return { name: options.name ?? 'direct', deliver };
}
