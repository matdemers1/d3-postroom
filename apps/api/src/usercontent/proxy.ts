// The image proxy's fetcher (PST-REQ-082). Remote images reach the reader only through here, and
// only after they asked: the sender sees the server, never the reader's address, browser or cookies.
//
// SSRF: every address a name resolves to is checked, and the connection is made to the address that
// was checked (a custom `lookup`, so DNS cannot answer differently the second time). Loopback,
// private, link-local, CGNAT, multicast, documentation and unspecified ranges are refused, IPv4-mapped
// and NAT64 IPv6 forms included. Redirects are followed by hand, at most three, and each hop is
// checked again from scratch. Only ports 80/443/8080/8443. Only raster image types, sniffed from the
// bytes as well as declared, at most MAX_BYTES, within TIMEOUT_MS. No cookie, no referrer, no
// credentials are ever sent.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

export const MAX_BYTES = 10 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const PORTS = new Set([80, 443, 8080, 8443]);
export const PROXY_USER_AGENT = 'Postroom-ImageProxy/1 (+https://github.com/matdemers1/d3-postroom)';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001::', 32], ['2002::', 16],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address an IPv6 one carries (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::/96). */
function embeddedV4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] === undefined || hex[2] === undefined) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${String(hi >> 8)}.${String(hi & 255)}.${String(lo >> 8)}.${String(lo & 255)}`;
}

/** True for any address a proxy on the home network must never be pointed at. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedV4(address);
    if (v4 !== null) return blocked.check(v4, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

export interface FetchPolicy {
  /** e2e only (IMAGE_PROXY_ALLOW_PRIVATE with POSTROOM_E2E_SEED): the test's listener is on loopback. */
  allowPrivate: boolean;
  /** Tests: a narrower rule than allowPrivate. */
  allowAddress?: (address: string) => boolean;
  maxBytes?: number;
  timeoutMs?: number;
}

export type FetchResult =
  | { ok: true; contentType: string; body: Buffer }
  | { ok: false; status: 400 | 403 | 404 | 413 | 415 | 502 | 504; reason: string };

const IMAGE_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/avif': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'image/bmp': (b) => b.subarray(0, 2).toString('latin1') === 'BM',
  'image/x-icon': (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  'image/vnd.microsoft.icon': (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
};

/** The declared type if it is a raster type we serve and the bytes agree with it. */
export function imageType(declared: string | undefined, body: Buffer): string | null {
  const type = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const normal = type === 'image/jpg' || type === 'image/pjpeg' ? 'image/jpeg' : type;
  const sniff = IMAGE_TYPES[normal];
  return sniff !== undefined && sniff(body) ? normal : null;
}

class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function allowed(policy: FetchPolicy, address: string): boolean {
  if (policy.allowAddress !== undefined) return policy.allowAddress(address);
  return policy.allowPrivate || !isPrivateAddress(address);
}

function guardedLookup(policy: FetchPolicy): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error !== null) {
        callback(error, '', 4);
        return;
      }
      // Every answer must pass: a name that resolves to one public and one private address is refused.
      const bad = addresses.find((a) => !allowed(policy, a.address));
      if (addresses.length === 0 || bad !== undefined) {
        callback(new Refused(`refused address ${bad?.address ?? '(none)'} for ${hostname}`), '', 4);
        return;
      }
      if (options.all === true) (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      else {
        const first = addresses[0] as LookupAddress;
        callback(null, first.address, first.family);
      }
    });
  };
}

/** Checks a URL before any socket opens; returns it parsed. */
export function checkUrl(raw: string, policy: FetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Refused('not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refused(`scheme ${url.protocol} refused`);
  if (url.username !== '' || url.password !== '') throw new Refused('credentials in URL refused');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!policy.allowPrivate && policy.allowAddress === undefined && !PORTS.has(port)) throw new Refused(`port ${String(port)} refused`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !allowed(policy, host)) throw new Refused(`refused address ${host}`);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!allowed(policy, '127.0.0.1')) throw new Refused('localhost refused');
  }
  return url;
}

function get(url: URL, policy: FetchPolicy, signal: AbortSignal): Promise<IncomingMessage> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      lookup: guardedLookup(policy),
      signal,
      agent: false,
      headers: { 'user-agent': PROXY_USER_AGENT, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8', 'accept-encoding': 'identity' },
    });
    req.once('response', resolve);
    req.once('error', reject);
    req.end();
  });
}

async function readCapped(res: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) {
      res.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function fetchImage(raw: string, policy: FetchPolicy): Promise<FetchResult> {
  const max = policy.maxBytes ?? MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, policy.timeoutMs ?? TIMEOUT_MS);
  try {
    let url = checkUrl(raw, policy);
    for (let hop = 0; ; hop++) {
      const res = await get(url, policy, controller.signal);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location !== undefined) {
        res.resume();
        if (hop >= MAX_REDIRECTS) return { ok: false, status: 502, reason: 'too many redirects' };
        url = checkUrl(new URL(res.headers.location, url).href, policy);
        continue;
      }
      if (status !== 200) {
        res.resume();
        return { ok: false, status: status === 404 ? 404 : 502, reason: `upstream answered ${String(status)}` };
      }
      const length = Number(res.headers['content-length'] ?? '0');
      if (length > max) {
        res.destroy();
        return { ok: false, status: 413, reason: 'too large' };
      }
      const body = await readCapped(res, max);
      if (body === null) return { ok: false, status: 413, reason: 'too large' };
      const type = imageType(res.headers['content-type'], body);
      if (type === null) return { ok: false, status: 415, reason: `not a served image type (${res.headers['content-type'] ?? 'none'})` };
      return { ok: true, contentType: type, body };
    }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, status: 403, reason: error.reason };
    if (controller.signal.aborted) return { ok: false, status: 504, reason: 'timed out' };
    // The lookup's refusal arrives wrapped by the socket.
    const cause = error instanceof Error ? error : new Error(String(error));
    if (cause instanceof Refused || /^refused /.test(cause.message)) return { ok: false, status: 403, reason: cause.message };
    return { ok: false, status: 502, reason: cause.message };
  } finally {
    clearTimeout(timer);
  }
}
