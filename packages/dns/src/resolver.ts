// The stub resolver client: talks to the configured (by default local) validating Unbound over
// UDP with a TCP fallback on truncation, retries on timeout, and drops any response whose id or
// question does not echo the query.
import { DnsProtocolError, DnsServfailError } from './errors.js';
import { normalizeName } from './name.js';
import { isTrustedResolverAddress, parseServer } from './trust.js';
import { RCode, RRType } from './types.js';
import type { DnsMessage, Resolver, ResolverResult } from './types.js';
import { decodeMessage, encodeQuery } from './wire.js';
import { sendTcp, sendUdp } from './transport.js';

export interface ResolverOptions {
  server?: string;
  timeoutMs?: number;
  tries?: number;
}

const DEFAULT_SERVER = '127.0.0.1:53';
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_TRIES = 2;

/** Anti-spoofing check: a response is only accepted when its id and echoed question match the
 * query that was sent. Exported for direct unit testing; not part of the public API surface. */
export function responseMatchesQuery(message: DnsMessage, expectedId: number, name: string, type: number): boolean {
  if (message.id !== expectedId) return false;
  if (!message.qr) return false;
  const question = message.questions[0];
  if (!question) return false;
  return normalizeName(question.name) === normalizeName(name) && question.type === type;
}

export function createResolver(opts: ResolverOptions = {}): Resolver {
  const server = opts.server ?? DEFAULT_SERVER;
  const { host, port } = parseServer(server);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tries = opts.tries ?? DEFAULT_TRIES;
  const trustAd = isTrustedResolverAddress(host);

  async function query(name: string, type: number): Promise<ResolverResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < tries; attempt++) {
      const { id, packet } = encodeQuery(name, type);
      let message: DnsMessage;
      try {
        const udpRaw = await sendUdp(host, port, packet, id, timeoutMs);
        const udpDecoded = decodeMessage(udpRaw);
        if (!udpDecoded.ok) {
          lastError = new DnsProtocolError(`malformed UDP response: ${udpDecoded.error}`);
          continue;
        }
        if (!responseMatchesQuery(udpDecoded.message, id, name, type)) {
          lastError = new DnsProtocolError('UDP response id/question did not match the query');
          continue;
        }
        if (udpDecoded.message.tc) {
          const tcpRaw = await sendTcp(host, port, packet, timeoutMs);
          const tcpDecoded = decodeMessage(tcpRaw);
          if (!tcpDecoded.ok) {
            lastError = new DnsProtocolError(`malformed TCP response: ${tcpDecoded.error}`);
            continue;
          }
          if (!responseMatchesQuery(tcpDecoded.message, id, name, type)) {
            lastError = new DnsProtocolError('TCP response id/question did not match the query');
            continue;
          }
          message = tcpDecoded.message;
        } else {
          message = udpDecoded.message;
        }
      } catch (err) {
        lastError = err;
        continue;
      }

      if (message.rcode === RCode.SERVFAIL) {
        throw new DnsServfailError(name, type);
      }
      return {
        rcode: message.rcode,
        ad: trustAd && message.ad,
        answers: message.answers,
        authority: message.authority,
      };
    }
    if (lastError instanceof Error) throw lastError;
    throw new DnsProtocolError(`DNS query for ${name} failed after ${String(tries)} tries`);
  }

  return {
    query,
    a: (name: string) => query(name, RRType.A),
    aaaa: (name: string) => query(name, RRType.AAAA),
    mx: (name: string) => query(name, RRType.MX),
    txt: (name: string) => query(name, RRType.TXT),
    tlsa: (name: string) => query(name, RRType.TLSA),
    ptr: (ip: string) => query(reverseDnsName(ip), RRType.PTR),
  };
}

/** Build the in-addr.arpa / ip6.arpa question name for a PTR lookup. */
export function reverseDnsName(ip: string): string {
  if (ip.includes(':')) {
    const expanded = expandIPv6(ip);
    const nibbles = expanded
      .split(':')
      .map((group) => group.padStart(4, '0'))
      .join('')
      .split('')
      .reverse()
      .join('.');
    return `${nibbles}.ip6.arpa.`;
  }
  const octets = ip.split('.');
  if (octets.length !== 4) {
    throw new RangeError(`not an IPv4 or IPv6 address: ${ip}`);
  }
  return `${octets.reverse().join('.')}.in-addr.arpa.`;
}

function expandIPv6(ip: string): string {
  const [head, tail] = ip.split('::');
  const headGroups = head === undefined || head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  if (ip.includes('::')) {
    const missing = 8 - headGroups.length - tailGroups.length;
    const middle = Array.from({ length: missing }, () => '0');
    return [...headGroups, ...middle, ...tailGroups].join(':');
  }
  return ip;
}
