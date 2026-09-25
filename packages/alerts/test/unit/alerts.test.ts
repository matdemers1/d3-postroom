import { describe, expect, it, vi } from 'vitest';
import { createAlertSender } from '../../src/index.js';

const CONFIG = { url: 'https://relay.test/send', token: 'secret-token', to: 'ops@d3cloud.io' };

describe('createAlertSender (PST-T-1.10)', () => {
  it('POSTs the D3 Auth relay contract: bearer token, JSON body of to/subject/text', async () => {
    const calls: { url: string | URL | Request; init: RequestInit }[] = [];
    const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const send = createAlertSender({ ...CONFIG, fetch: fakeFetch });
    const result = await send({ subject: 'Credential frozen', text: 'details here' });
    expect(result).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(CONFIG.url);
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${CONFIG.token}`);
    expect(headers['content-type']).toBe('application/json');
    const body = typeof call?.init.body === 'string' ? call.init.body : '';
    expect(JSON.parse(body)).toEqual({ to: CONFIG.to, subject: 'Credential frozen', text: 'details here' });
  });

  it('unconfigured relay: logs a structured line and never throws', async () => {
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const fakeFetch = vi.fn();
    const send = createAlertSender({ fetch: fakeFetch as typeof fetch }, { log: (event, fields = {}) => logs.push({ event, fields }) });
    const result = await send({ subject: 'x', text: 'y' });
    expect(result).toEqual({ sent: false, reason: 'relay unconfigured' });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(logs).toEqual([{ event: 'alert-not-sent', fields: { reason: 'relay unconfigured', key: 'x' } }]);
  });

  it('dedupes the same key within an hour, but not after', async () => {
    let now = new Date('2026-09-25T00:00:00Z');
    const fakeFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const send = createAlertSender({ ...CONFIG, fetch: fakeFetch }, { now: () => now });
    expect(await send({ subject: 'a', text: '1', key: 'k' })).toEqual({ sent: true });
    now = new Date(now.getTime() + 30 * 60_000);
    expect(await send({ subject: 'a', text: '2', key: 'k' })).toEqual({ sent: false, reason: 'deduped' });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 31 * 60_000); // now > 1h since the first send
    expect(await send({ subject: 'a', text: '3', key: 'k' })).toEqual({ sent: true });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('a relay that never answers times out rather than throwing', async () => {
    const fakeFetch = vi.fn((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'TimeoutError')); });
    }));
    const send = createAlertSender({ ...CONFIG, fetch: fakeFetch as typeof fetch, timeoutMs: 20 });
    const result = await send({ subject: 'slow', text: 'x' });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('relay request failed');
  }, 2000);

  it('a non-2xx response is not sent', async () => {
    const fakeFetch = vi.fn(() => Promise.resolve(new Response('nope', { status: 500 })));
    const send = createAlertSender({ ...CONFIG, fetch: fakeFetch });
    const result = await send({ subject: 'bad', text: 'x' });
    expect(result).toEqual({ sent: false, reason: 'relay responded 500' });
  });
});
