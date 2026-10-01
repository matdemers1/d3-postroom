// One auth runtime per app: the parsed secrets, the throttle, the OIDC client and the short-lived
// in-memory stores (pending setups, TOTP challenges). Built once per ApiDeps and shared by every
// router and middleware createApp mounts.
import { kekFromBase64, type Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import type { ApiDeps } from '../deps.js';
import { WindowLimiter } from '../mobileconfig/link.js';
import { readStored, resolveD3Auth, type D3AuthState } from './d3auth-settings.js';
import { OidcProvider, type OidcSettings } from './oidc.js';
import { isSecureOrigin } from './sessions.js';
import { SignInThrottle } from './throttle.js';

export interface PendingSetup {
  displayName: string;
  login: string;
  passwordHash: string;
  totpSecret: string;
  exp: number;
  attempts: number;
}

export interface TotpChallenge {
  accountId: string;
  login: string;
  exp: number;
  /** Code checks claimed on this challenge, counted BEFORE any hashing (PST-T-16.26). */
  attempts: number;
  /**
   * A code check is running on this challenge. Only one at a time: a recovery-code check is up to
   * ten Argon2id verifies, and concurrent guesses must not each get to run them.
   */
  checking: boolean;
}

/**
 * A TOTP re-enrolment in flight for one session that signed in with a recovery code (PST-REQ-200).
 * Keyed by session id; nothing is written to the account until a code from the new secret proves it.
 */
export interface PendingReenrol {
  accountId: string;
  secret: string;
  exp: number;
  attempts: number;
  checking: boolean;
}

export const SETUP_TTL_MS = 15 * 60 * 1000;
/** Failed password sign-ins from one address, across all logins, before the delay starts. */
export const IP_FREE_ATTEMPTS = 20;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** How long a re-enrolment key waits for its first code before Begin has to be pressed again. */
export const REENROL_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
/**
 * Re-enrolment Begins one session may make per REENROL_TTL_MS (PST-T-16.28). A repeat inside the
 * window answers the same pending secret; past this many it is refused 429.
 */
export const REENROL_BEGINS_PER_WINDOW = 5;
/** Step-up is fresh for five minutes (PST-REQ-008). */
export const STEP_UP_MS = 5 * 60 * 1000;

export interface AuthRuntime {
  db: Db;
  webOrigin: string;
  secure: boolean;
  now: () => Date;
  pepper: string | null;
  sessionSecret: string | null;
  /** SETUP_TOKEN; null means setup is accepted from private addresses only. */
  setupToken: string | null;
  kek: Kek | null;
  domain: string;
  throttle: SignInThrottle;
  /**
   * Every login from one address, counted together, against spraying many accounts from one place
   * (ASVS 5.0 6.1.1, 2.4.1): an unknown login still costs a decoy Argon2id hash. More free attempts
   * than the per-login throttle, so a household behind one address is not slowed by one typo.
   */
  ipThrottle: SignInThrottle;
  /**
   * Sign in with D3 Auth. Replaced in place when the console saves new settings (PST-ADR-014), so
   * read it through the runtime on every request; never hold on to a client or its settings.
   */
  oidc: OidcProvider;
  /** Where the live D3 Auth settings came from, without the secret; updated with every replace. */
  d3auth: D3AuthState;
  /** D3AUTH_* from the server's env, the fallback when no row is saved. */
  envOidc: OidcSettings | null;
  setups: BoundedMap<PendingSetup>;
  challenges: BoundedMap<TotpChallenge>;
  reenrols: BoundedMap<PendingReenrol>;
  /** Re-enrolment Begins per session id (PST-T-16.28). */
  reenrolBegins: WindowLimiter;
}

/** A Map that forgets its oldest entry past `limit`, and entries whose `exp` has passed. */
export class BoundedMap<V extends { exp: number }> {
  private readonly map = new Map<string, V>();
  constructor(private readonly limit: number) {}

  set(key: string, value: V): void {
    if (this.map.size >= this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done !== true) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  /** The live entry, or undefined (an expired one is removed on the way). */
  get(key: string, now: number): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    if (value.exp <= now) {
      this.map.delete(key);
      return undefined;
    }
    return value;
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

const runtimes = new WeakMap<ApiDeps, AuthRuntime>();

function blank(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function loadKek(base64: string | undefined): Kek | null {
  const value = blank(base64);
  if (value === null) return null;
  try {
    return kekFromBase64(value);
  } catch (error) {
    // The message never includes the key (kekFromBase64's contract).
    process.stderr.write(`${JSON.stringify({ event: 'kek-invalid', error: error instanceof Error ? error.message : String(error) })}\n`);
    return null;
  }
}

export function oidcSettings(deps: ApiDeps): OidcSettings | null {
  const issuer = blank(deps.config.d3authIssuer);
  const clientId = blank(deps.config.d3authClientId);
  const clientSecret = blank(deps.config.d3authClientSecret);
  if (issuer === null || clientId === null || clientSecret === null) return null;
  return {
    issuer: issuer.replace(/\/+$/, ''),
    clientId,
    clientSecret,
    redirectUri: redirectUriFor(deps.config.webOrigin),
  };
}

export function redirectUriFor(webOrigin: string): string {
  return new URL('/api/auth/oidc/callback', webOrigin).toString();
}

/**
 * The D3 Auth settings in force, from the saved row or the env. A database that cannot be read
 * falls back to the env and says so, rather than leaving the server without its server-file setup.
 */
export async function loadD3Auth(rt: AuthRuntime): Promise<ReturnType<typeof resolveD3Auth>> {
  try {
    return resolveD3Auth(await readStored(rt.db), rt.kek, rt.envOidc, redirectUriFor(rt.webOrigin));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ event: 'd3auth-settings-unreadable', error: message })}\n`);
    const fallback = resolveD3Auth(null, rt.kek, rt.envOidc, redirectUriFor(rt.webOrigin));
    return { ...fallback, state: { ...fallback.state, error: 'The saved settings could not be read from the database; the server file applies until they can.' } };
  }
}

export function runtimeFor(deps: ApiDeps): AuthRuntime {
  let rt = runtimes.get(deps);
  if (rt !== undefined) return rt;
  const now = deps.config.now ?? (() => new Date());
  const envOidc = oidcSettings(deps);
  // Nothing until the saved row is read: every reader of rt.oidc waits for the load below.
  const oidc = new OidcProvider(null);
  rt = {
    db: deps.db,
    webOrigin: deps.config.webOrigin,
    secure: isSecureOrigin(deps.config.webOrigin),
    now,
    pepper: blank(deps.config.passwordPepper),
    sessionSecret: blank(deps.config.sessionSecret),
    setupToken: blank(deps.config.setupToken),
    kek: loadKek(deps.config.kekBase64),
    domain: blank(deps.config.domain) ?? 'd3cloud.io',
    throttle: new SignInThrottle(),
    ipThrottle: new SignInThrottle(IP_FREE_ATTEMPTS),
    oidc,
    d3auth: { source: 'none', enabled: false, issuer: null, clientId: null, secretSet: false, error: null },
    envOidc,
    setups: new BoundedMap(32),
    challenges: new BoundedMap(1_000),
    reenrols: new BoundedMap(256),
    reenrolBegins: new WindowLimiter(REENROL_BEGINS_PER_WINDOW, REENROL_TTL_MS, 1_000),
  };
  runtimes.set(deps, rt);
  const live = rt;
  // The saved row (PST-ADR-014) wins over the env; read once at boot, never fatal. Then discovery,
  // never awaited either: the password path does not wait on it.
  oidc.load(async () => {
    const resolved = await loadD3Auth(live);
    live.d3auth = resolved.state;
    return resolved.settings;
  });
  void oidc.get();
  return rt;
}
