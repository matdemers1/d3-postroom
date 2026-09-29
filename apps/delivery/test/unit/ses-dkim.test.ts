// The SES transport drops the Ed25519 DKIM-Signature (SES refuses two: "554 Transaction failed:
// Duplicate header 'DKIM-Signature'", production 2026-09-28) and the RSA signature must still verify.
import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { signMessage, verifyLocal } from '@postroom/auth-checks';
import { dropEd25519DkimFields, HEADER_CAP, withoutEd25519Dkim } from '../../src/transports/ses-dkim.js';

const MESSAGE = Buffer.from(
  'From: Matthew <matthew@d3cloud.io>\r\nTo: someone@example.org\r\nSubject: Hello\r\nDate: Sun, 28 Sep 2026 12:00:00 +0000\r\n' +
    'Message-ID: <abc@d3cloud.io>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHi there.\r\n.leading dot line\r\n',
  'latin1',
);

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

/** Feed the input in small chunks, so the header block spans several of them. */
function chunked(buf: Buffer, size = 7): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}

describe('SES relay drops the Ed25519 DKIM signature (PST-REQ-045)', () => {
  it('keeps the RSA signature, which still verifies, and the body byte for byte', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ed = generateKeyPairSync('ed25519');
    const sigs = await signMessage(MESSAGE, {
      domain: 'd3cloud.io',
      keys: [
        { selector: 'pr202609r', algorithm: 'rsa-sha256', privateKey: rsa.privateKey },
        { selector: 'pr202609e', algorithm: 'ed25519-sha256', privateKey: ed.privateKey },
      ],
    });
    expect(sigs).toHaveLength(2);
    const signed = Buffer.concat([...sigs.map((s) => Buffer.from(s, 'latin1')), MESSAGE]);

    const out = await collect(withoutEd25519Dkim(chunked(signed)));
    const text = out.toString('latin1');
    const headerBlock = text.slice(0, text.indexOf('\r\n\r\n'));
    expect(headerBlock.match(/^dkim-signature:/gim)).toHaveLength(1);
    expect(headerBlock).toMatch(/a=rsa-sha256/);
    expect(headerBlock).not.toMatch(/ed25519/);
    // Everything after the Ed25519 field is untouched, body included.
    expect(out.subarray(out.length - MESSAGE.length).equals(MESSAGE)).toBe(true);

    const results = await verifyLocal(out, { pr202609r: rsa.publicKey, pr202609e: ed.publicKey });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ result: 'pass', selector: 'pr202609r' });
  });

  it('the RSA signature still verifies after SES replaces the Message-ID (PST-T-11.19)', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sigs = await signMessage(MESSAGE, { domain: 'd3cloud.io', keys: [{ selector: 'pr202609r', algorithm: 'rsa-sha256', privateKey: rsa.privateKey }] });
    expect(sigs[0]).not.toMatch(/message-id/i);
    const relayed = Buffer.from(
      Buffer.concat([...sigs.map((sig) => Buffer.from(sig, 'latin1')), MESSAGE])
        .toString('latin1')
        .replace('Message-ID: <abc@d3cloud.io>', 'Message-ID: <010001a0eab97b0f-57a466ee@email.amazonses.com>'),
      'latin1',
    );
    const results = await verifyLocal(relayed, { pr202609r: rsa.publicKey });
    expect(results[0]).toMatchObject({ result: 'pass', selector: 'pr202609r' });
  });

  it('removes a folded Ed25519 field, including a= split by folding whitespace, and nothing else', () => {
    const block = [
      'DKIM-Signature: v=1; a=rsa-sha256; d=d3cloud.io; s=r;',
      '\th=from; bh=x; b=y',
      'DKIM-Signature: v=1; a=ed25519-',
      ' sha256; d=d3cloud.io; s=e;',
      '\tbh=x; b=z',
      'X-Other: keep me',
      'From: a@d3cloud.io',
    ].join('\r\n');
    expect(dropEd25519DkimFields(block)).toBe(
      ['DKIM-Signature: v=1; a=rsa-sha256; d=d3cloud.io; s=r;', '\th=from; bh=x; b=y', 'X-Other: keep me', 'From: a@d3cloud.io'].join('\r\n'),
    );
  });

  it('keeps an Ed25519 signature when it is the only one (DMARC needs at least one)', () => {
    const block = ['DKIM-Signature: v=1; a=ed25519-sha256; d=d3cloud.io; s=e; bh=x; b=z', 'From: a@d3cloud.io'].join('\r\n');
    expect(dropEd25519DkimFields(block)).toBe(block);
  });

  it('passes a message through unchanged when it has no Ed25519 signature', async () => {
    const out = await collect(withoutEd25519Dkim(chunked(MESSAGE, 3)));
    expect(out.equals(MESSAGE)).toBe(true);
  });

  it('does not buffer past the header cap: an endless header block is passed through as is', async () => {
    const huge = Buffer.concat([Buffer.from('X-Pad: ', 'latin1'), Buffer.alloc(HEADER_CAP + 10, 0x61), Buffer.from('\r\n\r\nbody', 'latin1')]);
    const out = await collect(withoutEd25519Dkim(chunked(huge, 64 * 1024)));
    expect(out.equals(huge)).toBe(true);
  });
});
