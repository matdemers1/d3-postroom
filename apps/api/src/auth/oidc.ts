// "Sign in with D3 Auth" — the second of the two permanent login paths (PST-REQ-005), on the shared
// relying-party SDK. Nothing here may be load-bearing for the password path: discovery is allowed
// to fail, at boot or later, and an unreachable issuer only means the button is disabled.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createAuthClient, identityKey, type AuthClient, type AuthClientOptions } from '@d3cloudio/auth-client';
import { normalizeDomain, normalizeLocalPart, type Prisma } from '@postroom/db';

export const SCOPE = 'openid profile email d3:roles';
/** How long after a failed discovery before trying again. */
export const RETRY_AFTER_MS = 30_000;
/** A discovery or token call that takes longer than this is an unavailable issuer. */
export const FETCH_TIMEOUT_MS = 5_000;

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type ClientFactory = (options: AuthClientOptions) => Promise<AuthClient>;

const timedFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Holds the discovered client, and discovers lazily: a failure at boot is retried on a later
 * request (no sooner than RETRY_AFTER_MS), so an issuer that comes back is offered again without a
 * restart. Never throws.
 *
 * The settings can change while the server runs (PST-ADR-014): the admin console saves new ones and
 * {@link replace} swaps them in, so every reader must go through this holder (`rt.oidc`) and never
 * keep a client or settings of its own. A discovery that was in flight for the old settings is
 * discarded when it lands. At boot the settings come from the database; {@link load} holds every
 * reader until they have.
 */
export class OidcProvider {
  private current: OidcSettings | null;
  private client: AuthClient | null = null;
  private inflight: Promise<AuthClient | null> | null = null;
  private lastFailureAt = -Infinity;
  /** Bumped by every replace: a discovery started under an older generation is stale. */
  private generation = 0;
  private loading: Promise<void> | null = null;
  private failure: string | null = null;

  constructor(
    settings: OidcSettings | null,
    private readonly factory: ClientFactory = createAuthClient,
  ) {
    this.current = settings;
  }

  get settings(): OidcSettings | null {
    return this.current;
  }

  get configured(): boolean {
    return this.current !== null;
  }

  /** Why the last discovery failed, or null once one succeeds (and after a replace). */
  get lastError(): string | null {
    return this.failure;
  }

  /** New settings (or none), effective for the next request. The old client is forgotten. */
  replace(settings: OidcSettings | null): void {
    this.generation += 1;
    this.current = settings;
    this.client = null;
    this.inflight = null;
    this.lastFailureAt = -Infinity;
    this.failure = null;
  }

  /**
   * Settings that arrive asynchronously (the saved row, at boot). Readers wait for them; a replace
   * made while this is running wins over what it loads.
   */
  load(source: () => Promise<OidcSettings | null>): void {
    const generation = this.generation;
    const task = source()
      .then((settings) => {
        if (this.generation === generation) this.replace(settings);
      })
      .catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify({ event: 'oidc-settings-load-failed', error: error instanceof Error ? error.message : String(error) })}\n`);
      })
      .finally(() => {
        if (this.loading === task) this.loading = null;
      });
    this.loading = task;
  }

  /** Resolves once any {@link load} in progress has finished. */
  async ready(): Promise<void> {
    while (this.loading !== null) await this.loading;
  }

  async get(now: number = Date.now()): Promise<AuthClient | null> {
    await this.ready();
    if (this.current === null) return null;
    if (this.client !== null) return this.client;
    if (this.inflight !== null) return this.inflight;
    if (now - this.lastFailureAt < RETRY_AFTER_MS) return null;
    const settings = this.current;
    const generation = this.generation;
    const inflight: Promise<AuthClient | null> = this.factory({
      issuer: settings.issuer,
      clientId: settings.clientId,
      // client_secret_basic: the SDK sends the secret in the Authorization header, which is what
      // D3 Auth accepts (it refuses client_secret_post).
      clientSecret: settings.clientSecret,
      redirectUri: settings.redirectUri,
      scope: SCOPE,
      ssoMode: 'optional',
      fetch: timedFetch,
      // Plain http only for a loopback issuer (a local fake in tests and e2e), never a real host.
      ...(settings.issuer.startsWith('http://') && isLoopback(settings.issuer) ? { allowInsecureHttp: true } : {}),
    })
      .then((client) => {
        // Settings replaced while this was discovering: the client belongs to the old ones.
        if (this.generation !== generation) return null;
        this.client = client;
        this.failure = null;
        return client;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (this.generation === generation) {
          this.lastFailureAt = now;
          this.failure = message.slice(0, 300);
        }
        process.stderr.write(`${JSON.stringify({ event: 'oidc-discovery-failed', issuer: settings.issuer, error: message })}\n`);
        return null;
      })
      .finally(() => {
        if (this.inflight === inflight) this.inflight = null;
      });
    this.inflight = inflight;
    return inflight;
  }

  /** Bumped by every {@link replace}: which settings a snapshot was taken under. */
  get currentGeneration(): number {
    return this.generation;
  }

  /**
   * The client together with the settings it was discovered for, taken in one synchronous step after
   * discovery, so a caller never pairs a client with settings a replace has since swapped in.
   */
  async snapshot(now: number = Date.now()): Promise<OidcSnapshot | null> {
    const client = await this.get(now);
    if (client === null || this.client !== client || this.current === null) return null;
    return { client, settings: this.current, generation: this.generation };
  }

  /**
   * Forget the client, so the next request rediscovers (used when a call to the issuer fails). With
   * `generation`, only if the settings are still those: a failure under settings a save has since
   * replaced says nothing about the new ones.
   */
  reset(now: number = Date.now(), generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    this.client = null;
    this.lastFailureAt = now;
  }
}

export interface OidcSnapshot {
  client: AuthClient;
  settings: OidcSettings;
  generation: number;
}

/** What went wrong with a fetch, in words: undici's "fetch failed" hides the reason in `cause`. */
function fetchErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return `No answer within ${FETCH_TIMEOUT_MS / 1000} s.`;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return `${error.message}: ${typeof code === 'string' ? code : cause.message}`;
  }
  return error.message;
}

/** A discovery document past this is refused unread (the admin Test button, PST-T-17.6). */
export const MAX_DISCOVERY_BYTES = 256 * 1024;

/** The body as text, or null (and the stream cancelled) as soon as it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (res.body === null) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving a for-await early cancels the stream: nothing past the cap is read.
  for await (const value of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += value.byteLength;
    if (total > max) return null;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface DiscoveryResult {
  ok: boolean;
  issuer: string;
  authorizationEndpoint?: string;
  error?: string;
}

/**
 * Fetch an issuer's discovery document, with the same timeout sign-in uses, and check it names
 * itself and an authorization endpoint. No client ID or secret is involved: this is "is D3 Auth
 * there", for the admin console's Test button. Never throws.
 */
export async function discoverIssuer(issuer: string, fetcher: typeof fetch = timedFetch): Promise<DiscoveryResult> {
  try {
    const res = await fetcher(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, issuer, error: `Discovery answered HTTP ${res.status}.` };
    }
    const text = await readCapped(res, MAX_DISCOVERY_BYTES);
    if (text === null) return { ok: false, issuer, error: `The discovery document is larger than ${MAX_DISCOVERY_BYTES / 1024} KiB.` };
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, issuer, error: 'The discovery document is not a JSON object.' };
    const doc = parsed as Record<string, unknown>;
    const named = typeof doc['issuer'] === 'string' ? doc['issuer'].replace(/\/+$/, '') : null;
    if (named !== issuer) return { ok: false, issuer, error: `The discovery document names a different issuer (${String(named).slice(0, 200)}).` };
    const authorizationEndpoint = doc['authorization_endpoint'];
    if (typeof authorizationEndpoint !== 'string' || authorizationEndpoint === '') {
      return { ok: false, issuer, error: 'The discovery document has no authorization_endpoint.' };
    }
    return { ok: true, issuer, authorizationEndpoint };
  } catch (error) {
    const message = fetchErrorMessage(error);
    return { ok: false, issuer, error: message.slice(0, 300) };
  }
}

// ─── The transaction cookie ─────────────────────────────────────────────────
// PKCE verifier, state and nonce ride in a short-lived cookie, AES-256-GCM-sealed under a key
// derived from SESSION_SECRET, so the browser that started the sign-in is the only one that can
// finish it, and nothing in it is readable or forgeable.

export const TX_COOKIE = 'postroom_oidc';
/** `__Host-` on a secure origin, like the session cookie (ASVS 5.0 3.3.1, 3.3.3); so Path=/. */
export const SECURE_TX_COOKIE = '__Host-postroom_oidc';

export function txCookieName(secure: boolean): string {
  return secure ? SECURE_TX_COOKIE : TX_COOKIE;
}
export const TX_TTL_MS = 10 * 60 * 1000;
const TAG_BYTES = 16;

export interface OidcTransaction {
  verifier: string;
  state: string;
  nonce: string;
  /** Epoch ms after which the callback refuses it. */
  exp: number;
  /** Set when a signed-in account started this to link a D3 Auth identity to itself. */
  linkAccountId?: string;
  /**
   * The issuer and client ID the sign-in started with. The callback refuses it if the settings have
   * changed since, before anything is sent to a token endpoint (PST-T-17.6).
   */
  iss: string;
  cid: string;
}

function txKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret, 'postroom', 'oidc-transaction-cookie', 32));
}

export function sealTransaction(sessionSecret: string, tx: OidcTransaction): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', txKey(sessionSecret), nonce, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(JSON.stringify(tx), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

export function openTransaction(sessionSecret: string, sealed: string): OidcTransaction | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 12 + TAG_BYTES + 2) return null;
    // A pinned tag length: GCM would otherwise accept a truncated tag, and a short tag is forgeable.
    const decipher = createDecipheriv('aes-256-gcm', txKey(sessionSecret), raw.subarray(0, 12), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(text) as Partial<OidcTransaction>;
    if (
      typeof parsed.verifier !== 'string' ||
      typeof parsed.state !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.exp !== 'number' ||
      typeof parsed.iss !== 'string' ||
      typeof parsed.cid !== 'string'
    ) {
      return null;
    }
    return {
      verifier: parsed.verifier,
      state: parsed.state,
      nonce: parsed.nonce,
      exp: parsed.exp,
      iss: parsed.iss,
      cid: parsed.cid,
      ...(typeof parsed.linkAccountId === 'string' ? { linkAccountId: parsed.linkAccountId } : {}),
    };
  } catch {
    return null;
  }
}

// ─── Identity resolution ────────────────────────────────────────────────────

/** The one refusal a person can act on: sign in with the password, then link deliberately. */
export class IdentityCollision extends Error {}

export interface CompletedIdentity {
  iss: string;
  sub: string;
  email?: string;
  name?: string;
  roles: string[];
  linkAccountId?: string;
}

export interface ResolvedIdentity {
  accountId: string;
  /** 'existing' by (iss, sub); 'linked' to the signed-in account; 'provisioned' a new account. */
  outcome: 'existing' | 'linked' | 'provisioned';
}

/**
 * Resolve a D3 Auth identity to a local account. **By (iss, sub), never by email** (PST-REQ-005):
 * an email is a display attribute a provider may change or reuse, and adopting "the account with
 * this address" would hand it to whoever can make D3 Auth assert that address.
 */
export async function resolveIdentity(tx: Prisma.TransactionClient, identity: CompletedIdentity, now: Date): Promise<ResolvedIdentity> {
  const key = identityKey({ iss: identity.iss, sub: identity.sub });
  if (!key.includes(identity.sub)) throw new Error('the SDK identity key no longer contains the subject');

  const email = identity.email ?? null;
  const existing = await tx.identityLink.findUnique({
    where: { issuer_subject: { issuer: identity.iss, subject: identity.sub } },
  });
  if (existing !== null) {
    await tx.identityLink.update({ where: { id: existing.id }, data: { lastUsedAt: now, email } });
    return { accountId: existing.accountId, outcome: 'existing' };
  }

  if (identity.linkAccountId !== undefined) {
    await tx.identityLink.create({
      data: { accountId: identity.linkAccountId, issuer: identity.iss, subject: identity.sub, email, lastUsedAt: now },
    });
    return { accountId: identity.linkAccountId, outcome: 'linked' };
  }

  // An address here already holds the email the provider asserts, and no identity links to it.
  // Refuse rather than adopt — and refuse as a handled outcome, never as a unique-violation 5xx.
  if (email !== null && (await addressExists(tx, email))) {
    throw new IdentityCollision(
      'An account here already uses that address. Sign in with your password, then link D3 Auth from your account — Postroom never joins the two by email.',
    );
  }

  const account = await tx.account.create({
    data: {
      displayName: (identity.name ?? email ?? 'D3 Auth user').slice(0, 200),
      identityLinks: { create: { issuer: identity.iss, subject: identity.sub, email, lastUsedAt: now } },
    },
  });
  return { accountId: account.id, outcome: 'provisioned' };
}

async function addressExists(tx: Prisma.TransactionClient, email: string): Promise<boolean> {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  let localPart: string;
  let domain: string;
  try {
    localPart = normalizeLocalPart(email.slice(0, at));
    domain = normalizeDomain(email.slice(at + 1));
  } catch {
    return false;
  }
  const found = await tx.address.findFirst({ where: { localPart, domain: { name: domain } }, select: { id: true } });
  return found !== null;
}
