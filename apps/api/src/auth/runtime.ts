// One auth runtime per app: the parsed secrets, the throttle, the OIDC client and the short-lived
// in-memory stores (pending setups, TOTP challenges). Built once per ApiDeps and shared by every
// router and middleware createApp mounts.
import { kekFromBase64, type Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import type { ApiDeps } from '../deps.js';
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
  attempts: number;
}

export const SETUP_TTL_MS = 15 * 60 * 1000;
/** Failed password sign-ins from one address, across all logins, before the delay starts. */
export const IP_FREE_ATTEMPTS = 20;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
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
  oidc: OidcProvider;
  setups: BoundedMap<PendingSetup>;
  challenges: BoundedMap<TotpChallenge>;
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
    redirectUri: new URL('/api/auth/oidc/callback', deps.config.webOrigin).toString(),
  };
}

export function runtimeFor(deps: ApiDeps): AuthRuntime {
  let rt = runtimes.get(deps);
  if (rt !== undefined) return rt;
  const now = deps.config.now ?? (() => new Date());
  const oidc = new OidcProvider(oidcSettings(deps));
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
    setups: new BoundedMap(32),
    challenges: new BoundedMap(1_000),
  };
  runtimes.set(deps, rt);
  // Discovery at boot, never awaited and never fatal: the password path does not wait on it.
  if (oidc.configured) void oidc.get();
  return rt;
}
