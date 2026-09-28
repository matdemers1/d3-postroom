// An RFC 8555 ACME client on fetch and node:crypto (PST-T-0.15, PST-REQ-020): directory, replay
// nonces, account, order, authorizations, challenge response, finalize, certificate download.
//
// Nonces: every response carries a fresh Replay-Nonce, which the next request uses; only when none
// is held is newNonce asked. A badNonce error is retried once with the nonce it came with (§6.5).
// Nothing here logs a JWS, a key or a nonce: the log gets URLs' paths and statuses only.
import type { KeyObject } from 'node:crypto';
import { publicJwk, signJws, type EcJwk } from './jws.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface AcmeDirectory {
  readonly newNonce: string;
  readonly newAccount: string;
  readonly newOrder: string;
  readonly meta?: { readonly termsOfService?: string };
}

export type OrderStatus = 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';

export interface AcmeOrder {
  readonly status: OrderStatus;
  readonly authorizations: readonly string[];
  readonly finalize: string;
  readonly certificate?: string;
  readonly error?: AcmeProblem;
}

export interface AcmeChallenge {
  readonly type: string;
  readonly url: string;
  readonly token: string;
  readonly status: string;
  readonly error?: AcmeProblem;
}

export interface AcmeAuthorization {
  readonly status: 'pending' | 'valid' | 'invalid' | 'deactivated' | 'expired' | 'revoked';
  readonly identifier: { readonly type: string; readonly value: string };
  readonly challenges: readonly AcmeChallenge[];
}

export interface AcmeProblem {
  readonly type?: string;
  readonly detail?: string;
  readonly status?: number;
}

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problem: AcmeProblem | null,
  ) {
    super(message);
    this.name = 'AcmeError';
  }
}

export const BAD_NONCE = 'urn:ietf:params:acme:error:badNonce';

export interface AcmeClientOptions {
  readonly directoryUrl: string;
  readonly accountKey: KeyObject;
  readonly fetch?: typeof fetch;
  readonly log?: Log;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly userAgent?: string;
  /** Per-request timeout. */
  readonly timeoutMs?: number;
  /** How long a poll (authorization, order) may run before it gives up. */
  readonly pollTimeoutMs?: number;
  readonly now?: () => number;
}

interface Response_ {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

function describe(problem: AcmeProblem | null, status: number): string {
  if (problem === null) return `HTTP ${String(status)}`;
  return `${problem.type ?? 'error'}${problem.detail === undefined ? '' : `: ${problem.detail}`}`;
}

function parseProblem(text: string): AcmeProblem | null {
  try {
    return JSON.parse(text) as AcmeProblem;
  } catch {
    return null;
  }
}

/** Retry-After (seconds or an HTTP date) → ms, clamped to [min, max]. */
export function retryAfterMs(header: string | null, fallbackMs: number, nowMs: number, maxMs = 60_000): number {
  if (header === null || header.trim() === '') return fallbackMs;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - nowMs;
  if (!Number.isFinite(ms)) return fallbackMs;
  return Math.min(maxMs, Math.max(1_000, ms));
}

export class AcmeClient {
  private readonly fetch: typeof fetch;
  private readonly log: Log;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly jwk: EcJwk;
  private dir: AcmeDirectory | null = null;
  private nonce: string | null = null;
  private kid: string | null = null;

  constructor(private readonly opts: AcmeClientOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.log = opts.log ?? (() => undefined);
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.jwk = publicJwk(opts.accountKey);
  }

  get accountJwk(): EcJwk {
    return this.jwk;
  }

  get accountUrl(): string | null {
    return this.kid;
  }

  private async request(url: string, init: RequestInit): Promise<Response_> {
    const headers = new Headers(init.headers);
    headers.set('user-agent', this.opts.userAgent ?? 'postroom-acme');
    const res = await this.fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    const nonce = res.headers.get('replay-nonce');
    if (nonce !== null && nonce !== '') this.nonce = nonce;
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  async directory(): Promise<AcmeDirectory> {
    if (this.dir !== null) return this.dir;
    const res = await this.request(this.opts.directoryUrl, { method: 'GET' });
    if (res.status !== 200) throw new AcmeError(`ACME directory answered HTTP ${String(res.status)}`, res.status, null);
    const dir = JSON.parse(res.text) as Partial<AcmeDirectory>;
    if (typeof dir.newNonce !== 'string' || typeof dir.newAccount !== 'string' || typeof dir.newOrder !== 'string') {
      throw new AcmeError('ACME directory is missing newNonce/newAccount/newOrder', res.status, null);
    }
    this.dir = dir as AcmeDirectory;
    return this.dir;
  }

  private async freshNonce(): Promise<string> {
    const dir = await this.directory();
    const res = await this.request(dir.newNonce, { method: 'HEAD' });
    const nonce = res.headers.get('replay-nonce');
    if (nonce === null || nonce === '') throw new AcmeError(`newNonce answered HTTP ${String(res.status)} without a Replay-Nonce`, res.status, null);
    return nonce;
  }

  /** One signed POST (payload null = POST-as-GET). Throws AcmeError on a problem document. */
  private async post(url: string, payload: unknown, opts: { useJwk?: boolean; accept?: string } = {}): Promise<Response_> {
    for (let attempt = 0; ; attempt++) {
      const nonce = this.nonce ?? (await this.freshNonce());
      this.nonce = null;
      let identity: { jwk: EcJwk } | { kid: string };
      if (opts.useJwk === true) identity = { jwk: this.jwk };
      else if (this.kid !== null) identity = { kid: this.kid };
      else throw new Error('ACME: no account yet (call account() first)');
      const body = JSON.stringify(signJws(this.opts.accountKey, { nonce, url, ...identity }, payload));
      const res = await this.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json', ...(opts.accept === undefined ? {} : { accept: opts.accept }) },
        body,
      });
      if (res.status < 400) return res;
      const problem = parseProblem(res.text);
      if (problem?.type === BAD_NONCE && attempt === 0) {
        this.log('acme-bad-nonce-retry', { path: pathOf(url) });
        continue;
      }
      throw new AcmeError(`ACME ${pathOf(url)}: ${describe(problem, res.status)}`, res.status, problem);
    }
  }

  private async postJson(url: string, payload: unknown): Promise<{ body: unknown; location: string | null; headers: Headers }> {
    const res = await this.post(url, payload);
    return { body: JSON.parse(res.text) as unknown, location: res.headers.get('location'), headers: res.headers };
  }

  /** newAccount with termsOfServiceAgreed; for an existing key the server answers 200 with the same URL. */
  async account(contact: readonly string[] = []): Promise<string> {
    const dir = await this.directory();
    const res = await this.post(dir.newAccount, { termsOfServiceAgreed: true, ...(contact.length === 0 ? {} : { contact }) }, { useJwk: true });
    const location = res.headers.get('location');
    if (location === null) throw new AcmeError('newAccount answered without a Location', res.status, null);
    this.kid = location;
    this.log('acme-account', { created: res.status === 201 });
    return location;
  }

  async newOrder(domains: readonly string[]): Promise<{ url: string; order: AcmeOrder }> {
    const dir = await this.directory();
    const res = await this.postJson(dir.newOrder, { identifiers: domains.map((value) => ({ type: 'dns', value })) });
    const body = res.body as AcmeOrder;
    const { location } = res;
    if (location === null) throw new AcmeError('newOrder answered without a Location', 201, null);
    this.log('acme-order', { status: body.status, authorizations: body.authorizations.length });
    return { url: location, order: body };
  }

  async getAuthorization(url: string): Promise<AcmeAuthorization> {
    return (await this.postJson(url, null)).body as AcmeAuthorization;
  }

  async getOrder(url: string): Promise<AcmeOrder> {
    return (await this.postJson(url, null)).body as AcmeOrder;
  }

  /** Tell the server the challenge is ready to be checked: an empty JSON object (§7.5.1). */
  async respondChallenge(url: string): Promise<AcmeChallenge> {
    return (await this.postJson(url, {})).body as AcmeChallenge;
  }

  async finalize(url: string, csrDer: Uint8Array): Promise<AcmeOrder> {
    return (await this.postJson(url, { csr: Buffer.from(csrDer).toString('base64url') })).body as AcmeOrder;
  }

  async downloadCertificate(url: string): Promise<string> {
    const res = await this.post(url, null, { accept: 'application/pem-certificate-chain' });
    if (!res.text.includes('-----BEGIN CERTIFICATE-----')) throw new AcmeError('the certificate download is not a PEM chain', res.status, null);
    return res.text;
  }

  /** POST-as-GET `url` until `done(body)` holds, honouring Retry-After, backing off 2 s → 30 s. */
  private async poll<T>(url: string, done: (body: T) => boolean, what: string): Promise<T> {
    const deadline = this.now() + (this.opts.pollTimeoutMs ?? 300_000);
    let waitMs = 2_000;
    for (;;) {
      const res = await this.postJson(url, null);
      const body = res.body as T;
      const { headers } = res;
      if (done(body)) return body;
      if (this.now() >= deadline) throw new AcmeError(`timed out waiting for the ${what}`, 0, null);
      await this.sleep(retryAfterMs(headers.get('retry-after'), waitMs, this.now()));
      waitMs = Math.min(30_000, waitMs * 2);
    }
  }

  async pollAuthorization(url: string): Promise<AcmeAuthorization> {
    return this.poll<AcmeAuthorization>(url, (a) => a.status !== 'pending', 'authorization');
  }

  async pollOrder(url: string, until: readonly OrderStatus[]): Promise<AcmeOrder> {
    return this.poll<AcmeOrder>(url, (o) => until.includes(o.status) || o.status === 'invalid', 'order');
  }
}
