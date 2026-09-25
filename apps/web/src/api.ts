// The web app's one door to the API. Same origin, cookies only, and the CSRF header on every
// state-changing request (the API refuses a non-GET without it).

export interface AuthState {
  setupRequired: boolean;
  oidcConfigured: boolean;
  oidcAvailable: boolean;
  signedIn: boolean;
  account?: { id: string; displayName: string; isAdmin: boolean; totpEnabled: boolean; address: string | null };
  method?: 'password' | 'oidc';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(code);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-postroom-csrf'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const code =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `http_${String(res.status)}`;
    throw new ApiError(res.status, code, parsed);
  }
  return parsed as T;
}

export const api = {
  state: () => call<AuthState>('GET', '/api/auth/state'),
  setupBegin: (input: { setupToken: string; displayName: string; login: string; password: string }) =>
    call<{ enrolToken: string; secret: string; otpauthUri: string }>('POST', '/api/auth/setup/begin', input),
  setupComplete: (input: { setupToken: string; enrolToken: string; code: string }) =>
    call<{ ok: true }>('POST', '/api/auth/setup/complete', input),
  signIn: (input: { login: string; password: string }) =>
    call<{ next: 'totp'; challenge: string }>('POST', '/api/auth/signin', input),
  signInTotp: (input: { challenge: string; code: string }) => call<{ next: 'done' }>('POST', '/api/auth/signin/totp', input),
  signOut: () => call<{ ok: true }>('POST', '/api/auth/signout'),
  stepUp: (code: string) => call<{ ok: true }>('POST', '/api/auth/step-up', { code }),
  adminSessions: () => call<{ sessions: AdminSession[] }>('GET', '/api/admin/sessions'),
  revokeSession: (id: string) => call<{ ok: true }>('DELETE', `/api/admin/sessions/${encodeURIComponent(id)}`),
};

export interface AdminSession {
  id: string;
  accountId: string;
  displayName: string;
  method: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Where a path must go for this auth state, or null to render it. Pure, so it is unit-tested. */
export function redirectFor(state: AuthState, pathname: string): string | null {
  if (state.setupRequired) return pathname === '/setup' ? null : '/setup';
  if (pathname === '/setup') return '/signin';
  if (!state.signedIn) return pathname === '/signin' ? null : '/signin';
  if (pathname === '/signin') return '/';
  if (pathname.startsWith('/admin') && state.account?.isAdmin !== true) return '/';
  return null;
}

/** A human sentence for an API refusal on the sign-in and setup screens. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Postroom did not answer. Check your connection and try again.';
  switch (error.code) {
    case 'invalid_credentials':
      return 'Those details did not match.';
    case 'invalid_code':
      return 'That code did not match. Try the current one.';
    case 'challenge_expired':
      return 'That took too long. Sign in again.';
    case 'too_many_attempts':
      return 'Too many attempts. Wait a moment and try again.';
    case 'totp_not_enrolled':
      return 'This account has no authenticator enrolled. Ask the operator to set one up.';
    case 'setup_complete':
      return 'Setup is already complete. Sign in instead.';
    case 'setup_token_required':
      return 'That setup token did not match. Copy SETUP_TOKEN from the server\'s env file.';
    case 'setup_expired':
      return 'Setup took too long. Start again.';
    case 'login_taken':
      return 'That login is already an address here. Choose another.';
    case 'invalid_request':
      return 'Check the highlighted fields.';
    case 'auth_not_configured':
      return 'Sign-in is not configured on this server yet.';
    default:
      return 'Something went wrong. Try again.';
  }
}
