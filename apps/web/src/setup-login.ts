// The setup form's login rules and field mapping (PST-T-11.6). Pure, so it is unit-tested.
import { ApiError } from './api';

const MIN_PASSWORD = 12;
export const DOMAIN = 'd3cloud.io';
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const FOREIGN_DOMAIN = `Just the name — it becomes name@${DOMAIN}. Other domains are not hosted here.`;

export type Field = 'setupToken' | 'displayName' | 'login' | 'password';

/** A full address at our own domain is its local part; anything else is left for the checks. */
export function localPartOf(login: string): string {
  const v = login.trim().toLowerCase();
  return v.endsWith(`@${DOMAIN}`) ? v.slice(0, -DOMAIN.length - 1) : v;
}

/** What is wrong with a login before it is sent, or null. */
export function loginProblem(login: string): string | null {
  const v = localPartOf(login);
  if (v === '') return null;
  if (v.includes('@')) return FOREIGN_DOMAIN;
  if (!LOCAL_PART.test(v)) return 'Use letters, digits, dot, dash or underscore, starting and ending with a letter or digit.';
  return null;
}

/** The server's per-field refusals (400 invalid_request), keyed by the form field they belong to. */
export function serverFieldErrors(caught: unknown): Partial<Record<Field, string>> {
  if (!(caught instanceof ApiError) || caught.code !== 'invalid_request') return {};
  const fields = (caught.body as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return {};
  const out: Partial<Record<Field, string>> = {};
  for (const f of fields as { path?: unknown; message?: unknown }[]) {
    const path = typeof f.path === 'string' ? f.path : '';
    const message = typeof f.message === 'string' ? f.message : 'Check this field.';
    if (path === 'login') out.login ??= message === 'foreign_domain' ? FOREIGN_DOMAIN : `Use ${message}.`;
    else if (path === 'password') out.password ??= `Use at least ${String(MIN_PASSWORD)} characters.`;
    else if (path === 'displayName') out.displayName ??= 'Enter a display name.';
    else if (path === 'setupToken') out.setupToken ??= 'Enter the setup token.';
  }
  return out;
}

