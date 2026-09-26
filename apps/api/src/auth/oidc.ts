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

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * Holds the discovered client, and discovers lazily: a failure at boot is retried on a later
 * request (no sooner than RETRY_AFTER_MS), so an issuer that comes back is offered again without a
 * restart. Never throws.
 */
export class OidcProvider {
  private client: AuthClient | null = null;
  private inflight: Promise<AuthClient | null> | null = null;
  private lastFailureAt = -Infinity;

  constructor(
    readonly settings: OidcSettings | null,
    private readonly factory: ClientFactory = createAuthClient,
  ) {}

  get configured(): boolean {
    return this.settings !== null;
  }

  async get(now: number = Date.now()): Promise<AuthClient | null> {
    if (this.settings === null) return null;
    if (this.client !== null) return this.client;
    if (this.inflight !== null) return this.inflight;
    if (now - this.lastFailureAt < RETRY_AFTER_MS) return null;
    const settings = this.settings;
    this.inflight = this.factory({
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
        this.client = client;
        return client;
      })
      .catch((error: unknown) => {
        this.lastFailureAt = now;
        process.stderr.write(
          `${JSON.stringify({ event: 'oidc-discovery-failed', issuer: settings.issuer, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Forget the client, so the next request rediscovers (used when a call to the issuer fails). */
  reset(now: number = Date.now()): void {
    this.client = null;
    this.lastFailureAt = now;
  }
}

// ─── The transaction cookie ─────────────────────────────────────────────────
// PKCE verifier, state and nonce ride in a short-lived cookie, AES-256-GCM-sealed under a key
// derived from SESSION_SECRET, so the browser that started the sign-in is the only one that can
// finish it, and nothing in it is readable or forgeable.

export const TX_COOKIE = 'postroom_oidc';
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
      typeof parsed.exp !== 'number'
    ) {
      return null;
    }
    return {
      verifier: parsed.verifier,
      state: parsed.state,
      nonce: parsed.nonce,
      exp: parsed.exp,
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
