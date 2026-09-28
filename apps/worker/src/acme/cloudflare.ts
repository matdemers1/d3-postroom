// The Cloudflare DNS API, only as far as a dns-01 challenge needs it (PST-T-0.15, PST-ADR-010):
// create, list and delete TXT records in ONE zone — the delegated challenge zone. The token
// (ACME_DNS_TOKEN) is scoped to that zone alone, so even a bug here cannot edit d3cloud.io; the
// job also refuses any name outside the zone before it gets this far. The token is never logged
// and never appears in an error message.

export interface TxtRecord {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

export interface DnsApi {
  createTxt(name: string, content: string): Promise<string>;
  listTxt(name: string): Promise<TxtRecord[]>;
  deleteRecord(id: string): Promise<void>;
}

export interface CloudflareOptions {
  readonly token: string;
  readonly zoneId: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** The shortest TTL Cloudflare allows on an unproxied record; the record lives for minutes. */
export const TXT_TTL = 60;

interface CfEnvelope<T> {
  readonly success?: boolean;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
  readonly result?: T;
}

export function cloudflareDnsApi(opts: CloudflareOptions): DnsApi {
  const base = `${opts.baseUrl ?? CLOUDFLARE_API}/zones/${encodeURIComponent(opts.zoneId)}/dns_records`;
  const doFetch = opts.fetch ?? fetch;

  async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await doFetch(url, {
      method,
      headers: { authorization: `Bearer ${opts.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    let envelope: CfEnvelope<T>;
    try {
      envelope = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new Error(`Cloudflare ${method} dns_records: HTTP ${String(res.status)} (no JSON body)`);
    }
    if (!res.ok || envelope.success !== true) {
      const errors = (envelope.errors ?? []).map((e) => `${String(e.code ?? '?')} ${e.message ?? ''}`.trim()).join('; ');
      throw new Error(`Cloudflare ${method} dns_records: HTTP ${String(res.status)}${errors === '' ? '' : ` (${errors})`}`);
    }
    return envelope.result as T;
  }

  return {
    async createTxt(name, content) {
      const result = await call<{ id?: string }>('POST', base, { type: 'TXT', name, content, ttl: TXT_TTL, comment: 'postroom acme dns-01 (PST-T-0.15)' });
      if (typeof result.id !== 'string') throw new Error('Cloudflare POST dns_records: no record id in the answer');
      return result.id;
    },
    async listTxt(name) {
      const url = `${base}?type=TXT&name=${encodeURIComponent(name)}&per_page=100`;
      const result = await call<{ id: string; name: string; content: string }[]>('GET', url);
      return result.map((r) => ({ id: r.id, name: r.name, content: r.content }));
    },
    async deleteRecord(id) {
      await call<unknown>('DELETE', `${base}/${encodeURIComponent(id)}`);
    },
  };
}
