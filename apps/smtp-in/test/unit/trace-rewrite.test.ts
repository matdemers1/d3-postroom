// PST-T-2.12: a forged Authentication-Results claiming our authserv-id is renamed before storage;
// a legitimate one from elsewhere, and Arc-Authentication-Results, are left exactly as received.
import { describe, expect, it } from 'vitest';
import { rewriteAuthenticationResults, streamFinalMessage } from '../../src/trace-rewrite.js';

const OUR_HOST = 'mx.d3cloud.io';

function block(text: string): Buffer {
  return Buffer.from(text.replace(/\n/g, '\r\n'), 'latin1');
}

describe('rewriteAuthenticationResults', () => {
  it('renames a forged Authentication-Results at the top of the headers', () => {
    const input = block('Authentication-Results: mx.d3cloud.io; dkim=pass header.d=evil.example\nFrom: a@evil.example\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST).toString('latin1');
    expect(out).toBe('X-Original-Authentication-Results: mx.d3cloud.io; dkim=pass header.d=evil.example\r\nFrom: a@evil.example\r\n');
  });

  it('renames a folded forged Authentication-Results', () => {
    const input = block('Authentication-Results: mx.d3cloud.io;\n\tdkim=pass header.d=evil.example\nFrom: a@evil.example\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST).toString('latin1');
    expect(out.startsWith('X-Original-Authentication-Results: mx.d3cloud.io;\n\tdkim=pass'.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('renames regardless of field-name case', () => {
    const input = block('AUTHENTICATION-RESULTS: mx.d3cloud.io; dkim=pass\nFrom: a@evil.example\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST).toString('latin1');
    expect(out.startsWith('X-Original-Authentication-Results:')).toBe(true);
  });

  it('renames when a version number follows the authserv-id (RFC 8601 §2.2)', () => {
    const input = block('Authentication-Results: mx.d3cloud.io 1; dkim=pass\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST).toString('latin1');
    expect(out.startsWith('X-Original-Authentication-Results:')).toBe(true);
  });

  it('renames when a comment precedes the authserv-id', () => {
    const input = block('Authentication-Results: (a comment) mx.d3cloud.io; dkim=pass\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST).toString('latin1');
    expect(out.startsWith('X-Original-Authentication-Results:')).toBe(true);
  });

  it('matches the authserv-id case-insensitively and ignores surrounding whitespace', () => {
    const input = block('Authentication-Results:   MX.D3CLOUD.IO  ;  dkim=pass\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST).toString('latin1');
    expect(out.startsWith('X-Original-Authentication-Results:')).toBe(true);
  });

  it('leaves a legitimate Authentication-Results from another authserv-id untouched', () => {
    const input = block('Authentication-Results: mx.google.com; dkim=pass header.d=example.com\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST);
    expect(out.equals(input)).toBe(true);
  });

  it('never touches Arc-Authentication-Results, even claiming our authserv-id', () => {
    const input = block('ARC-Authentication-Results: i=1; mx.d3cloud.io; dkim=pass\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST);
    expect(out.equals(input)).toBe(true);
  });

  it('leaves every other header field byte-identical', () => {
    const input = block(
      'Authentication-Results: mx.d3cloud.io; dkim=pass\nFrom: a@evil.example\nSubject: hi\nTo: matt@d3cloud.io\n',
    );
    const out = rewriteAuthenticationResults(input, OUR_HOST).toString('latin1');
    expect(out).toContain('From: a@evil.example\r\n');
    expect(out).toContain('Subject: hi\r\n');
    expect(out).toContain('To: matt@d3cloud.io\r\n');
  });

  it('is a no-op with no Authentication-Results field at all', () => {
    const input = block('From: a@example.com\nSubject: hi\n');
    const out = rewriteAuthenticationResults(input, OUR_HOST);
    expect(out.equals(input)).toBe(true);
  });
});

describe('streamFinalMessage', () => {
  async function collect(gen: AsyncGenerator<Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of gen) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async function* asyncBytes(buf: Buffer, chunkSize: number): AsyncGenerator<Buffer> {
    await Promise.resolve();
    for (let i = 0; i < buf.length; i += chunkSize) yield buf.subarray(i, i + chunkSize);
  }

  it('prepends trace, rewrites the header, and streams the body unchanged, chunked arbitrarily', async () => {
    const trace = Buffer.from('Received: from x\r\nAuthentication-Results: mx.d3cloud.io; dkim=pass\r\n', 'latin1');
    const original = Buffer.from(
      'Authentication-Results: mx.d3cloud.io; dkim=pass header.d=evil.example\r\nFrom: a@evil.example\r\n\r\nhello body\r\n',
      'latin1',
    );
    const headerBlockLen = original.indexOf('\r\n\r\n') + 2;
    const header = { block: original.subarray(0, headerBlockLen), headerOnly: false };
    for (const chunkSize of [1, 3, 7, 4096]) {
      const out = await collect(streamFinalMessage(trace, header, asyncBytes(original, chunkSize), 'mx.d3cloud.io'));
      const text = out.toString('latin1');
      expect(text.indexOf('Authentication-Results:')).toBe(text.indexOf('Authentication-Results: mx.d3cloud.io; dkim=pass\r\n'));
      expect(text).toContain('X-Original-Authentication-Results: mx.d3cloud.io; dkim=pass header.d=evil.example\r\n');
      expect(text.endsWith('hello body\r\n')).toBe(true);
      expect(text).toContain('From: a@evil.example\r\n');
    }
  });

  it('streams the whole message unchanged when the header exceeded the cap', async () => {
    const trace = Buffer.from('Received: from x\r\n', 'latin1');
    const original = Buffer.from('whatever bytes\r\n', 'latin1');
    const out = await collect(streamFinalMessage(trace, { block: null, headerOnly: false }, asyncBytes(original, 4), 'mx.d3cloud.io'));
    expect(out.equals(Buffer.concat([trace, original]))).toBe(true);
  });

  it('emits nothing past the rewritten header when the whole message was header-only', async () => {
    const trace = Buffer.from('Received: from x\r\n', 'latin1');
    const original = Buffer.from('Authentication-Results: mx.d3cloud.io; dkim=pass\r\n', 'latin1');
    const out = await collect(streamFinalMessage(trace, { block: original, headerOnly: true }, asyncBytes(original, 4), 'mx.d3cloud.io'));
    expect(out.equals(Buffer.concat([trace, Buffer.from('X-Original-Authentication-Results: mx.d3cloud.io; dkim=pass\r\n', 'latin1')]))).toBe(
      true,
    );
  });
});
