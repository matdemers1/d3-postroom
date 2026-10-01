// Sign in with D3 Auth, configured from the admin console (PST-ADR-014, PST-REQ-201, PST-REQ-204).
//
// The settings live in one `setting` row, `auth:d3auth`, with the client secret sealed under the KEK
// (AAD `setting:auth:d3auth`, so a sealed value copied into another row will not open). A saved row
// wins over the D3AUTH_* environment; a turned-off row (`{ enabled: false }`) wins too, so the
// console can switch off what the server file turned on. Nothing here ever returns the secret.
import { openWithKek, sealWithKek, type Kek } from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';
import { z } from 'zod';
import { isLoopback, type OidcProvider, type OidcSettings } from './oidc.js';

export const D3AUTH_SETTING_KEY = 'auth:d3auth';
const SECRET_AAD = 'setting:auth:d3auth';

export const KEK_NOT_LOADED = 'The server key is not loaded; the saved settings cannot be read';
export const SECRET_UNOPENABLE = 'The saved client secret cannot be opened with the server key now loaded. Save the settings again with the secret.';
export const ROW_UNREADABLE = 'The saved settings are not in a form this server reads. Save them again.';

/** Where the live settings came from: a row saved in the console, the server's env file, or nowhere. */
export type D3AuthSource = 'console' | 'server_file' | 'none';

/** The row's value. A turned-off row carries `enabled: false` and nothing else that matters. */
export interface StoredD3Auth {
  enabled: boolean;
  issuer?: string;
  clientId?: string;
  /** base64 of sealWithKek(kek, utf8 secret, 'setting:auth:d3auth'). */
  sealedSecret?: string;
  updatedAt: string;
}

/** What the server is running with, without the secret. Kept on the runtime beside rt.oidc. */
export interface D3AuthState {
  source: D3AuthSource;
  enabled: boolean;
  issuer: string | null;
  clientId: string | null;
  secretSet: boolean;
  /** Why the saved settings are not what is running (server key missing, secret unopenable), or null. */
  error: string | null;
}

export interface D3AuthResolved {
  state: D3AuthState;
  settings: OidcSettings | null;
}

const StoredShape = z.object({
  enabled: z.boolean(),
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  sealedSecret: z.string().optional(),
  updatedAt: z.string(),
});

export function parseStored(value: unknown): StoredD3Auth | null {
  const parsed = StoredShape.safeParse(value);
  if (!parsed.success) return null;
  const { enabled, issuer, clientId, sealedSecret, updatedAt } = parsed.data;
  return {
    enabled,
    updatedAt,
    ...(issuer === undefined ? {} : { issuer }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(sealedSecret === undefined ? {} : { sealedSecret }),
  };
}

/** The saved row: absent, unreadable, or its value. */
export async function readStored(db: Db | Prisma.TransactionClient): Promise<StoredD3Auth | null | 'invalid'> {
  const row = await db.setting.findUnique({ where: { key: D3AUTH_SETTING_KEY } });
  if (row === null) return null;
  return parseStored(row.value) ?? 'invalid';
}

export function sealClientSecret(kek: Kek, secret: string): string {
  return sealWithKek(kek, Buffer.from(secret, 'utf8'), SECRET_AAD).toString('base64');
}

export function openClientSecret(kek: Kek, sealed: string): string {
  return openWithKek(kek, Buffer.from(sealed, 'base64'), SECRET_AAD).toString('utf8');
}

/** The secret a saved row holds, opened, or null when there is none or it will not open. */
export function savedSecret(kek: Kek, stored: StoredD3Auth | null | 'invalid'): string | null {
  if (stored === null || stored === 'invalid' || stored.sealedSecret === undefined) return null;
  try {
    return openClientSecret(kek, stored.sealedSecret);
  } catch {
    return null;
  }
}

/**
 * The settings in force: a saved row wins; with none, the env (already turned into OidcSettings by
 * runtime.ts); with the KEK missing, the env again, saying why the row was passed over.
 */
export function resolveD3Auth(
  stored: StoredD3Auth | null | 'invalid',
  kek: Kek | null,
  env: OidcSettings | null,
  redirectUri: string,
): D3AuthResolved {
  const fromEnv = (error: string | null): D3AuthResolved =>
    env === null
      ? { state: { source: 'none', enabled: false, issuer: null, clientId: null, secretSet: false, error }, settings: null }
      : { state: { source: 'server_file', enabled: true, issuer: env.issuer, clientId: env.clientId, secretSet: true, error }, settings: env };
  if (stored === null) return fromEnv(null);
  if (stored === 'invalid') {
    return { state: { source: 'console', enabled: false, issuer: null, clientId: null, secretSet: false, error: ROW_UNREADABLE }, settings: null };
  }
  const base = {
    source: 'console' as const,
    enabled: stored.enabled,
    issuer: stored.issuer ?? null,
    clientId: stored.clientId ?? null,
    secretSet: stored.sealedSecret !== undefined,
  };
  // Turned off needs no key to read: it wins over the env whether or not the KEK is loaded.
  if (!stored.enabled) return { state: { ...base, error: null }, settings: null };
  if (kek === null) return fromEnv(KEK_NOT_LOADED);
  if (stored.issuer === undefined || stored.clientId === undefined || stored.sealedSecret === undefined) {
    return { state: { ...base, error: ROW_UNREADABLE }, settings: null };
  }
  const secret = savedSecret(kek, stored);
  if (secret === null) return { state: { ...base, error: SECRET_UNOPENABLE }, settings: null };
  return {
    state: { ...base, error: null },
    settings: { issuer: stored.issuer, clientId: stored.clientId, clientSecret: secret, redirectUri },
  };
}

/**
 * The row as an audit before/after: never the sealed secret, only whether one is there. The keys
 * avoid the redactor's secret-ish words so the record stays readable.
 */
export function auditView(stored: StoredD3Auth | null | 'invalid'): Record<string, unknown> | null {
  if (stored === null) return null;
  if (stored === 'invalid') return { unreadable: true };
  return { enabled: stored.enabled, issuer: stored.issuer ?? null, clientId: stored.clientId ?? null, clientAuth: stored.sealedSecret === undefined ? 'none' : 'sealed' };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * An issuer as the settings keep it: https (plain http only for a loopback host, as discovery
 * allows), no credentials, query or fragment, and no trailing slash. Null when it is none of those.
 */
export function normalizeIssuer(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  if (url.protocol === 'http:') {
    if (!isLoopback(url.toString())) return null;
  } else if (url.protocol !== 'https:') {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.includes('//')) return null;
  return `${url.origin}${path}`;
}

export const ISSUER_MESSAGE = 'an https URL (plain http only for localhost), with no query, fragment or credentials';

export const RETYPE_SECRET = 'Enter the client secret again when the issuer or client ID changes.';

export const D3AuthSaveBody = z.object({
  issuer: z.string().trim().min(1).max(500).describe(`The D3 Auth issuer: ${ISSUER_MESSAGE}. A trailing slash is dropped.`),
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/, 'printable characters, no spaces')
    .describe('The client ID D3 Auth issued for Postroom.'),
  clientSecret: z
    .string()
    .min(1)
    .max(500)
    .regex(/^\P{Cc}+$/u, 'no control characters')
    .optional()
    .describe('Required when no secret is saved yet; left out, the saved one is kept. Sealed under the server key; never returned.'),
});

export const D3AuthTestBody = z.object({
  issuer: z.string().trim().min(1).max(500).optional().describe('The issuer to try; left out, the one in force.'),
});

export const D3AuthRole = z.object({ key: z.string(), display: z.string(), default: z.boolean().optional() });

export const D3AuthManifest = z.object({
  client_id: z.string(),
  name: z.literal('Postroom'),
  client_type: z.literal('confidential_web'),
  redirect_uris: z.array(z.string()),
  post_logout_redirect_uris: z.array(z.string()),
  backchannel_logout_uri: z.string(),
  roles: z.array(D3AuthRole),
});

export const D3AuthView = z.object({
  source: z.enum(['console', 'server_file', 'none']),
  enabled: z.boolean(),
  issuer: z.string().nullable(),
  clientId: z.string().nullable(),
  secretSet: z.boolean(),
  status: z.enum(['available', 'unavailable', 'not_configured']),
  lastError: z.string().nullable(),
  redirectUri: z.string(),
  backchannelLogoutUri: z.string(),
  postLogoutRedirectUri: z.string(),
  manifest: D3AuthManifest,
  signedOut: z
    .boolean()
    .optional()
    .describe('PUT and DELETE only: the change ended D3 Auth sessions and the caller’s own was one of them; its cookie is cleared.'),
});
export type D3AuthView = z.infer<typeof D3AuthView>;

export const D3AuthTestResult = z.object({
  ok: z.boolean(),
  issuer: z.string(),
  authorizationEndpoint: z.string().optional(),
  error: z.string().optional(),
});

// ─── The view ────────────────────────────────────────────────────────────────

export interface D3AuthUris {
  redirectUri: string;
  backchannelLogoutUri: string;
  postLogoutRedirectUri: string;
}

export function d3authUris(webOrigin: string): D3AuthUris {
  return {
    redirectUri: new URL('/api/auth/oidc/callback', webOrigin).toString(),
    backchannelLogoutUri: new URL('/api/auth/oidc/backchannel-logout', webOrigin).toString(),
    postLogoutRedirectUri: new URL('/signin', webOrigin).toString(),
  };
}

/**
 * What the admin screen shows: where the settings came from, whether D3 Auth answers now, the URIs
 * to register and a manifest to paste into D3 Auth (PST-REQ-204). Runs discovery if it is due.
 */
export async function buildD3AuthView(oidc: OidcProvider, state: D3AuthState, webOrigin: string, nowMs: number): Promise<D3AuthView> {
  await oidc.ready();
  let status: D3AuthView['status'];
  if (oidc.configured) status = (await oidc.get(nowMs)) !== null ? 'available' : 'unavailable';
  else status = state.enabled ? 'unavailable' : 'not_configured';
  const discoveryError = status === 'unavailable' ? (oidc.lastError ?? 'D3 Auth has not answered discovery yet.') : null;
  const uris = d3authUris(webOrigin);
  return {
    source: state.source,
    enabled: state.enabled,
    issuer: state.issuer,
    clientId: state.clientId,
    secretSet: state.secretSet,
    status,
    lastError: state.error ?? discoveryError,
    ...uris,
    manifest: {
      client_id: state.clientId ?? 'postroom',
      name: 'Postroom',
      client_type: 'confidential_web',
      redirect_uris: [uris.redirectUri],
      post_logout_redirect_uris: [uris.postLogoutRedirectUri],
      backchannel_logout_uri: uris.backchannelLogoutUri,
      roles: [
        { key: 'admin', display: 'Administrator' },
        { key: 'member', display: 'Member', default: true },
      ],
    },
  };
}
