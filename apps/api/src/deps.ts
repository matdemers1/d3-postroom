import type { Db } from '@postroom/db';

export interface ApiConfig {
  /** Absolute path of the built web app, served as statics; unset in tests. */
  webDist: string | undefined;
  /** Public origin, e.g. https://mail.d3cloud.io — used for cookies and OIDC redirects. */
  webOrigin: string;
  revision: string;
  /**
   * Server-side pepper for Argon2id (passed as argon2's `secret`), never stored beside the hash.
   * Unset means the password path answers 503 rather than hashing without it.
   */
  passwordPepper?: string | undefined;
  /** Keys the short-lived OIDC transaction cookie. Unset means sign-in answers 503. */
  sessionSecret?: string | undefined;
  /** Base64 of the 32-byte KEK (POSTROOM_KEK) that seals TOTP secrets at rest. */
  kekBase64?: string | undefined;
  /** D3 Auth. All three set means "configured"; any blank means the button is never offered. */
  d3authIssuer?: string | undefined;
  d3authClientId?: string | undefined;
  d3authClientSecret?: string | undefined;
  /** The primary mail domain, used only when /setup finds none in the database. */
  domain?: string | undefined;
  /** The clock. Injected by tests so the five-minute step-up window can be walked past. */
  now?: (() => Date) | undefined;
}

export interface ApiDeps {
  db: Db;
  config: ApiConfig;
  env: NodeJS.ProcessEnv;
}
