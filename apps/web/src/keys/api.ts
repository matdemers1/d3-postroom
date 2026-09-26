// The Keys API client (PST-T-12.2, PST-REQ-161): its own thin `call`, the same shape as
// apps/web/src/api.ts's (same origin, cookies only, the CSRF header on every state-changing request)
// since that file's `call` is not exported and api.ts is shared across builders. Plain .ts so unit
// tests import it without @d3cloud/ui's CSS.
import { ApiError } from '../api';

export type KeyKind = 'pgp' | 'smime';

export interface CryptoKeyJson {
  id: string;
  kind: KeyKind;
  owner: 'own' | 'contact';
  address: string;
  fingerprint: string;
  algorithm: string;
  userIds: string[];
  hasPrivate: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type ImportKeyInput =
  | { kind: 'pgp'; armored: string; passphrase?: string; address?: string }
  | { kind: 'smime'; certificate: string; privateKey?: string; passphrase?: string; address?: string };

export interface PublicExport {
  id: string;
  kind: KeyKind;
  fingerprint: string;
  filename: string;
  publicKey: string;
}

export interface SecretExport {
  id: string;
  kind: KeyKind;
  fingerprint: string;
  filename: string;
  protected: boolean;
  secret: string;
}

export type RevocationReason = 'none' | 'superseded' | 'compromised' | 'retired';

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-postroom-csrf'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
    const code = typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : `http_${String(res.status)}`;
    throw new ApiError(res.status, code, parsed);
  }
  return parsed as T;
}

const at = (id: string): string => `/api/keys/${encodeURIComponent(id)}`;

export const keysApi = {
  list: () => call<{ keys: CryptoKeyJson[] }>('GET', '/api/keys'),
  generate: (address: string, name?: string) => call<{ key: CryptoKeyJson }>('POST', '/api/keys/generate', { address, ...(name === undefined || name === '' ? {} : { name }) }),
  import: (input: ImportKeyInput) => call<{ key: CryptoKeyJson }>('POST', '/api/keys/import', input),
  exportPublic: (id: string) => call<PublicExport>('GET', `${at(id)}/export`),
  /** Needs a fresh step-up: throws ApiError('step_up_required') otherwise. */
  exportSecret: (id: string, passphrase?: string) => call<SecretExport>('POST', `${at(id)}/export-secret`, passphrase === undefined || passphrase === '' ? {} : { passphrase }),
  revoke: (id: string, reason: RevocationReason) => call<{ key: CryptoKeyJson }>('POST', `${at(id)}/revoke`, { reason }),
  remove: (id: string) => call<{ ok: true }>('DELETE', at(id)),
};
