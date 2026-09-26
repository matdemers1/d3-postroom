// The compose templates API client (PST-T-9.2, PST-REQ-144): its own thin `call`, the same shape as
// apps/web/src/api.ts's (same origin, cookies only, the CSRF header on every state-changing request)
// since that file's `call` is not exported and api.ts is shared across builders. Kept in its own
// module (not .tsx) so unit tests can import it without pulling in @d3cloud/ui's CSS.
import { ApiError } from '../api';

export interface TemplateJson {
  id: string;
  shortcut: string;
  name: string;
  subject: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  shortcut: string;
  name: string;
  subject?: string;
  body: string;
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
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

export const templatesApi = {
  list: () => call<{ templates: TemplateJson[] }>('GET', '/api/templates'),
  get: (id: string) => call<{ template: TemplateJson }>('GET', `/api/templates/${encodeURIComponent(id)}`),
  create: (input: TemplateInput) => call<{ template: TemplateJson }>('POST', '/api/templates', input),
  update: (id: string, input: TemplateInput) => call<{ template: TemplateJson }>('PUT', `/api/templates/${encodeURIComponent(id)}`, input),
  remove: (id: string) => call<null>('DELETE', `/api/templates/${encodeURIComponent(id)}`),
};

export const mdnApi = {
  /** Send an RFC 8098 read receipt for a message that asked for one (PST-REQ-146). */
  send: (messageId: string) => call<{ messageId: string; outboundId: string; sentMessageId: string }>('POST', `/api/messages/${encodeURIComponent(messageId)}/mdn`, {}),
};
