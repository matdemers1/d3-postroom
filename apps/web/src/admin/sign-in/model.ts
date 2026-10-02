// PST-T-17.7 (PST-REQ-201, PST-REQ-202, PST-REQ-204): the rules of the Sign in with D3 Auth screen
// and the account row, held in plain TypeScript so they are unit-tested without a browser.
import { ApiError, type D3AuthConfig, type D3AuthSource, type LinkedIdentity } from '../../api';

export type DotTone = 'neutral' | 'warning' | 'danger' | 'idle';

export interface StatusLine {
  tone: DotTone;
  /** The status in words: the dot is decoration. */
  label: string;
  /** Why it is unavailable, when the server knows. */
  detail: string | null;
  /** Where the live settings come from, or null when nothing is configured. */
  source: string | null;
}

export const SOURCE_LABEL: Readonly<Record<D3AuthSource, string | null>> = {
  console: 'set here in the console',
  server_file: 'from the server’s env file',
  none: null,
};

/** The header's status: neutral when it works, attention when it needs you (D-016), idle when off. */
export function statusLine(config: D3AuthConfig): StatusLine {
  const source = SOURCE_LABEL[config.source];
  switch (config.status) {
    case 'available':
      return { tone: 'neutral', label: 'Available', detail: null, source };
    case 'unavailable':
      return { tone: 'warning', label: 'Unavailable', detail: config.lastError, source };
    default:
      return { tone: 'idle', label: 'Not configured', detail: null, source: null };
  }
}

export const SECRET_SAVED_HELP = 'Saved — enter a new one to replace it.';
export const SECRET_NEW_HELP = 'D3 Auth shows it once, when you register Postroom.';
export const SECRET_AGAIN_HELP = 'Enter the secret again: the issuer or client ID changed, and the saved one stays with the old one.';

export interface D3AuthForm {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** The form as the server last answered it. The secret is write-only, so it always starts empty. */
export function formFrom(config: D3AuthConfig | null): D3AuthForm {
  return { issuer: config?.issuer ?? '', clientId: config?.clientId ?? '', clientSecret: '' };
}

/** The PUT body: trimmed, and the secret only when one was typed (absent keeps the saved one). */
export function saveInput(form: D3AuthForm): { issuer: string; clientId: string; clientSecret?: string } {
  const secret = form.clientSecret.trim();
  return { issuer: form.issuer.trim(), clientId: form.clientId.trim(), ...(secret === '' ? {} : { clientSecret: secret }) };
}

const sameIssuer = (a: string, b: string): boolean => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Whether Save needs a secret typed (PST-T-17.6): when none is saved, or when the issuer or client
 * ID moved — the server never sends a saved secret to a different issuer or client.
 */
export function secretNeeded(config: Pick<D3AuthConfig, 'secretSet' | 'issuer' | 'clientId'>, form: D3AuthForm): 'new' | 'again' | null {
  if (!config.secretSet) return 'new';
  if (!sameIssuer(form.issuer, config.issuer ?? '') || form.clientId.trim() !== (config.clientId ?? '')) return 'again';
  return null;
}

export type FieldErrors = Partial<Record<keyof D3AuthForm, string>>;

const FIELD_COPY: Readonly<Record<keyof D3AuthForm, string>> = {
  issuer: 'Enter D3 Auth’s address, starting https:// — for example https://auth.d3cloud.io.',
  clientId: 'Enter the client ID D3 Auth gave Postroom.',
  clientSecret: 'Enter the client secret D3 Auth showed when you registered Postroom.',
};

function fieldOf(path: string): keyof D3AuthForm | null {
  const key = path.split('.').pop()?.toLowerCase() ?? '';
  if (key === 'issuer') return 'issuer';
  if (key === 'clientid' || key === 'client_id') return 'clientId';
  if (key === 'clientsecret' || key === 'client_secret') return 'clientSecret';
  return null;
}

/**
 * Which fields a refused save names, in our words. Reads `fields: [{ path }]` (the auth routes'
 * validation shape), `fields: { issuer: … }`, `field: 'issuer'`, or an `invalid_issuer` /
 * `invalid_client_id` code. Empty when the refusal names no field.
 */
export function fieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiError) || error.status !== 400) return {};
  const out: FieldErrors = {};
  const mark = (path: string): void => {
    const field = fieldOf(path);
    if (field !== null) out[field] = FIELD_COPY[field];
  };
  const body = (typeof error.body === 'object' && error.body !== null ? error.body : {}) as Record<string, unknown>;
  const fields = body['fields'];
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (typeof f === 'object' && f !== null && typeof (f as { path?: unknown }).path === 'string') mark((f as { path: string }).path);
      else if (typeof f === 'string') mark(f);
    }
  } else if (typeof fields === 'object' && fields !== null) {
    for (const key of Object.keys(fields)) mark(key);
  }
  if (typeof body['field'] === 'string') mark(body['field']);
  if (error.code === 'invalid_issuer') mark('issuer');
  if (error.code === 'invalid_client_id') mark('clientId');
  return out;
}

/** The manifest as it is pasted into D3 Auth: two-space JSON. */
export function manifestText(manifest: Record<string, unknown>): string {
  return JSON.stringify(manifest, null, 2);
}

/** The four steps, in order, under "Register Postroom in D3 Auth". */
export const REGISTER_STEPS: readonly { title: string; detail: string }[] = [
  { title: 'Register Postroom in D3 Auth', detail: 'In D3 Auth’s console, add an app from the manifest below — it carries the three addresses.' },
  { title: 'Grant yourself access', detail: 'Give your D3 Auth account access to Postroom, so it may sign in here.' },
  { title: 'Paste the secret here', detail: 'Copy the client ID and secret D3 Auth shows into Connect to D3 Auth, test the connection, then Save.' },
  { title: 'Link your account', detail: 'In Settings › Account, choose Link… beside Sign in with D3 Auth.' },
];

export const TURN_OFF_COPY = 'Postroom stops offering Sign in with D3 Auth, and anyone signed in through it is signed out. Everyone keeps signing in with their password and authenticator code.';
export const UNLINK_COPY = 'Postroom will no longer accept D3 Auth for this account. Your password keeps working.';

/** The account row's description: who it is linked to, or what linking does. */
export function accountRowDescription(identity: LinkedIdentity | null): string {
  if (identity === null) return 'Use your D3 Auth account to sign in here';
  return `Linked to ${identity.email ?? 'your D3 Auth account'}`;
}

// ─── Coming back from a link (PST-T-17.16, PST-ADR-015) ─────────────────────

/** The step-up prompt's reason when a link needs a fresh code first. */
export const LINK_STEP_UP_WHY = 'Linking D3 Auth adds a way to sign in to this account';

export type AccountLinkNotice = { kind: 'error'; message: string } | { kind: 'step_up' };

/**
 * The refusals a link can come back with, by code. The URL carries a code, never the words, so a
 * crafted link cannot put its own text on the Account screen.
 */
export const LINK_ERROR_COPY: Readonly<Record<string, string>> = {
  linked_elsewhere: 'This D3 Auth account is already linked to another Postroom account. Unlink it there first.',
};

/**
 * What the server's redirect back to Settings › Account carries after a link it would not make:
 * `link_error=<code>` (shown as its copy; an unknown code is ignored), or `link_step_up=1` (the
 * session is older than five minutes — confirm with a code, then the link starts again).
 */
export function accountLinkNoticeFrom(search: string): AccountLinkNotice | null {
  const params = new URLSearchParams(search);
  const code = params.get('link_error');
  const message = code === null || !Object.hasOwn(LINK_ERROR_COPY, code) ? undefined : LINK_ERROR_COPY[code];
  if (message !== undefined) return { kind: 'error', message };
  if (params.get('link_step_up') === '1') return { kind: 'step_up' };
  return null;
}

export interface SigninNotice {
  message: string;
  /** D3 Auth reached no linked account: signing in with the password goes on to link it. */
  linkAfter: boolean;
}

/** What a refused D3 Auth sign-in carries back to /signin: its reason, and whether to link after. */
export function signinNoticeFrom(search: string): SigninNotice | null {
  const params = new URLSearchParams(search);
  const message = params.get('signin_error');
  if (message === null) return null;
  return { message: message.slice(0, 500), linkAfter: params.get('link_after_signin') === '1' };
}
