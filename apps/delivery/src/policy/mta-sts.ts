// MTA-STS (RFC 8461), hand-rolled: the `_mta-sts` TXT record, the policy fetched over strict HTTPS,
// its parser, MX pattern matching and a per-domain cache (PST-T-7.5, PST-REQ-126).
//
//   §3.1  TXT `_mta-sts.<domain>`: "v=STSv1; id=<1-32 alnum>". More than one STSv1 record = no policy.
//   §3.3  GET https://mta-sts.<domain>/.well-known/mta-sts.txt — WebPKI-valid certificate for that
//         name, no redirects, 200 only, text/plain; we also cap the size and the time.
//   §3.2  version / mode / mx / max_age.
//   §4.1  MX patterns: exact, or "*." matching exactly one left-most label.
//   §5.1  A cached, unexpired policy is used when the TXT record is missing or its id is unchanged,
//         and when a refresh fails; a failed fetch with nothing cached is "no policy".
//
// Every name, including mta-sts.<domain>, resolves through our own resolver, never the OS's.
import https from 'node:https';
import { isIPv4 } from 'node:net';
import tls from 'node:tls';
import { RCode, type Resolver } from '@postroom/dns';

export type MtaStsMode = 'enforce' | 'testing' | 'none';

export interface MtaStsPolicy {
  mode: MtaStsMode;
  /** Lowercased, no trailing dot. */
  mx: string[];
  /** Seconds, 0..31557600. */
  maxAge: number;
}

export interface CachedMtaStsPolicy {
  id: string;
  policy: MtaStsPolicy;
  /** Epoch ms. */
  fetchedAt: number;
  /** Epoch ms: fetchedAt + max_age. */
  expiresAt: number;
}

/** Where fetched policies live between attempts. Memory by default; see createSettingPolicyStore. */
export interface MtaStsCache {
  get: (domain: string) => Promise<CachedMtaStsPolicy | undefined>;
  set: (domain: string, entry: CachedMtaStsPolicy) => Promise<void>;
}

export interface MtaStsOptions {
  resolver: Resolver;
  cache?: MtaStsCache;
  /** Trust roots for the policy fetch. Default: Node's bundled (system) roots. Tests inject a test CA. */
  ca?: string | Buffer | (string | Buffer)[];
  /** Default 443; tests point it at a loopback HTTPS server. */
  port?: number;
  /** Whole-fetch deadline. Default 10 s. */
  timeoutMs?: number;
  /** Body cap. Default 64 KiB (RFC 8461 §3.3 suggests senders limit it). */
  maxBytes?: number;
  ipv4Only?: boolean;
  now?: () => number;
}

export type MtaStsLookup =
  | { kind: 'none'; reason: string }
  | { kind: 'policy'; id: string; policy: MtaStsPolicy; source: 'fetched' | 'cache' };

const MAX_AGE_LIMIT = 31_557_600;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

function bare(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

/** RFC 8461 §3.1. Returns the id, or null when `text` is not a valid STSv1 record. */
export function parseStsTxt(text: string): string | null {
  const fields = text.split(';').map((f) => f.trim()).filter((f) => f !== '');
  const first = fields[0];
  if (first !== 'v=STSv1') return null;
  for (const field of fields.slice(1)) {
    const eq = field.indexOf('=');
    if (eq <= 0) return null;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    if (key === 'id') return /^[A-Za-z0-9]{1,32}$/.test(value) ? value : null;
  }
  return null;
}

export type ParsePolicyResult = { ok: true; policy: MtaStsPolicy } | { ok: false; error: string };

/** RFC 8461 §3.2. Lines end in CRLF or LF; unknown keys are ignored; the first of a repeated key wins (mx accumulates). */
export function parsePolicy(body: string): ParsePolicyResult {
  let version: string | undefined;
  let mode: string | undefined;
  let maxAgeText: string | undefined;
  const mx: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { ok: false, error: `malformed policy line: ${JSON.stringify(line.slice(0, 80))}` };
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === 'version') version ??= value;
    else if (key === 'mode') mode ??= value;
    else if (key === 'max_age') maxAgeText ??= value;
    else if (key === 'mx') mx.push(bare(value));
  }
  if (version !== 'STSv1') return { ok: false, error: `unsupported policy version ${JSON.stringify(version ?? null)}` };
  if (mode !== 'enforce' && mode !== 'testing' && mode !== 'none') return { ok: false, error: `invalid policy mode ${JSON.stringify(mode ?? null)}` };
  if (maxAgeText === undefined || !/^\d{1,10}$/.test(maxAgeText)) return { ok: false, error: 'missing or invalid max_age' };
  const maxAge = Number(maxAgeText);
  if (maxAge > MAX_AGE_LIMIT) return { ok: false, error: `max_age ${maxAgeText} above ${String(MAX_AGE_LIMIT)}` };
  for (const pattern of mx) {
    if (!/^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(pattern)) return { ok: false, error: `invalid mx pattern ${JSON.stringify(pattern)}` };
  }
  if (mode !== 'none' && mx.length === 0) return { ok: false, error: `mode ${mode} without any mx` };
  return { ok: true, policy: { mode, mx, maxAge } };
}

/** RFC 8461 §4.1: exact match, or "*.example.com" matching exactly one extra left-most label. */
export function mxMatchesPattern(mxHost: string, pattern: string): boolean {
  const host = bare(mxHost);
  const p = bare(pattern);
  if (!p.startsWith('*.')) return host === p;
  const suffix = p.slice(1); // ".example.com"
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, host.length - suffix.length);
  return label !== '' && !label.includes('.');
}

export function mxMatchesPolicy(mxHost: string, policy: MtaStsPolicy): boolean {
  return policy.mx.some((p) => mxMatchesPattern(mxHost, p));
}

export function memoryPolicyCache(): MtaStsCache {
  const entries = new Map<string, CachedMtaStsPolicy>();
  return {
    get: (domain) => Promise.resolve(entries.get(bare(domain))),
    set: (domain, entry) => {
      entries.set(bare(domain), entry);
      return Promise.resolve();
    },
  };
}

/** The minimal shape of the Prisma `setting` delegate this store needs. */
export interface SettingDelegate {
  findUnique: (args: { where: { key: string } }) => Promise<{ value: unknown } | null>;
  upsert: (args: { where: { key: string }; create: { key: string; value: CachedMtaStsPolicy & Record<string, unknown> }; update: { value: CachedMtaStsPolicy & Record<string, unknown> } }) => Promise<unknown>;
}

function isCachedPolicy(value: unknown): value is CachedMtaStsPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const policy = v['policy'] as Record<string, unknown> | undefined;
  return typeof v['id'] === 'string' && typeof v['fetchedAt'] === 'number' && typeof v['expiresAt'] === 'number' &&
    typeof policy === 'object' && ['enforce', 'testing', 'none'].includes(String(policy['mode'])) &&
    Array.isArray(policy['mx']) && typeof policy['maxAge'] === 'number';
}

/**
 * A cache persisted in the `setting` table under `mta-sts:<domain>`, so a restart does not forget a
 * policy (RFC 8461 §5: a policy must survive until max_age, or an attacker who strips the TXT record
 * after a restart would win). Wraps a memory cache so each attempt does not hit the database.
 */
export function createSettingPolicyStore(setting: SettingDelegate): MtaStsCache {
  const memory = memoryPolicyCache();
  return {
    get: async (domain) => {
      const hit = await memory.get(domain);
      if (hit !== undefined) return hit;
      const row = await setting.findUnique({ where: { key: `mta-sts:${bare(domain)}` } });
      if (row === null || !isCachedPolicy(row.value)) return undefined;
      await memory.set(domain, row.value);
      return row.value;
    },
    set: async (domain, entry) => {
      await memory.set(domain, entry);
      const value = { ...entry } as CachedMtaStsPolicy & Record<string, unknown>;
      await setting.upsert({ where: { key: `mta-sts:${bare(domain)}` }, create: { key: `mta-sts:${bare(domain)}`, value }, update: { value } });
    },
  };
}

export class PolicyFetchError extends Error {
  override readonly name = 'PolicyFetchError';
}

/** GET the policy over HTTPS: WebPKI-verified for `host`, 200 only (no redirects), text/plain, bounded. */
export async function fetchPolicyText(host: string, options: MtaStsOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const addresses: string[] = [];
  const a = await options.resolver.a(host);
  for (const rr of a.answers) if (rr.kind === 'A') addresses.push(rr.address);
  if (options.ipv4Only === false) {
    const aaaa = await options.resolver.aaaa(host);
    for (const rr of aaaa.answers) if (rr.kind === 'AAAA') addresses.push(rr.address);
  }
  const ip = addresses[0];
  if (ip === undefined) throw new PolicyFetchError(`${host} has no address`);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const done = (error: Error | null, text?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolve(text ?? '');
      else { req.destroy(); reject(error); }
    };
    const req = https.request({
      host: ip,
      family: isIPv4(ip) ? 4 : 6,
      port: options.port ?? 443,
      method: 'GET',
      path: '/.well-known/mta-sts.txt',
      headers: { Host: host, Accept: 'text/plain', 'User-Agent': 'postroom-mta-sts' },
      servername: host,
      agent: false,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      // Hold the certificate to the policy host's name, not the address we dialled.
      checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert),
    }, (res) => {
      if (res.statusCode !== 200) {
        done(new PolicyFetchError(`https://${host}/.well-known/mta-sts.txt answered HTTP ${String(res.statusCode)} (redirects are not followed)`));
        return;
      }
      const type = (res.headers['content-type'] ?? '').toLowerCase();
      if (!type.startsWith('text/plain')) {
        done(new PolicyFetchError(`policy served as ${JSON.stringify(type)}, not text/plain`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          done(new PolicyFetchError(`policy larger than ${String(maxBytes)} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => { done(null, Buffer.concat(chunks).toString('utf8')); });
      res.on('error', (error) => { done(new PolicyFetchError(`reading policy: ${error.message}`)); });
    });
    const timer = setTimeout(() => { done(new PolicyFetchError(`policy fetch from ${host} timed out after ${String(timeoutMs)} ms`)); }, timeoutMs);
    req.on('error', (error) => { done(new PolicyFetchError(`fetching https://${host}/.well-known/mta-sts.txt: ${error.message}`)); });
    req.end();
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The MTA-STS policy in force for `domain`, per RFC 8461 §3–§5. Never throws: any failure is either
 * the cached policy (when one is still valid) or "no policy", with the reason.
 */
export async function lookupMtaSts(domain: string, options: MtaStsOptions, cache: MtaStsCache): Promise<MtaStsLookup> {
  const now = (options.now ?? Date.now)();
  const name = bare(domain);
  let cached: CachedMtaStsPolicy | undefined;
  try {
    cached = await cache.get(name);
  } catch {
    cached = undefined;
  }
  const valid = cached !== undefined && cached.expiresAt > now ? cached : undefined;
  const fromCache = (why: string): MtaStsLookup =>
    valid === undefined ? { kind: 'none', reason: why } : { kind: 'policy', id: valid.id, policy: valid.policy, source: 'cache' };

  let id: string | null;
  try {
    const txt = await options.resolver.txt(`_mta-sts.${name}`);
    if (txt.rcode !== RCode.NOERROR && txt.rcode !== RCode.NXDOMAIN) return fromCache(`_mta-sts TXT lookup answered rcode ${String(txt.rcode)}`);
    const records = txt.answers.flatMap((rr) => (rr.kind === 'TXT' && rr.text.startsWith('v=STSv1') ? [rr.text] : []));
    if (records.length > 1) return fromCache('more than one STSv1 TXT record');
    const only = records[0];
    if (only === undefined) return fromCache('no _mta-sts TXT record');
    id = parseStsTxt(only);
    if (id === null) return fromCache(`invalid _mta-sts TXT record ${JSON.stringify(only.slice(0, 80))}`);
  } catch (error) {
    return fromCache(`_mta-sts TXT lookup failed: ${errorText(error)}`);
  }

  if (valid?.id === id) return fromCache('unchanged id');

  const host = `mta-sts.${name}`;
  let parsed: ParsePolicyResult;
  try {
    parsed = parsePolicy(await fetchPolicyText(host, options));
  } catch (error) {
    return fromCache(`policy fetch failed: ${errorText(error)}`);
  }
  if (!parsed.ok) return fromCache(`invalid policy: ${parsed.error}`);
  const entry: CachedMtaStsPolicy = { id, policy: parsed.policy, fetchedAt: now, expiresAt: now + parsed.policy.maxAge * 1000 };
  try {
    await cache.set(name, entry);
  } catch {
    // A cache that cannot store still leaves this attempt with the fresh policy.
  }
  return { kind: 'policy', id, policy: parsed.policy, source: 'fetched' };
}
