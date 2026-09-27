// PST-T-12.7, PST-REQ-161: two canonicalization gaps the PST-T-12.6 verifier found.
//   (a) a part already quoted-printable and 7bit-safe was kept byte for byte, so a line starting
//       "From " stayed unescaped and an mbox relay rewriting it to ">From" broke the signature
//       (RFC 3156 §3). It is now re-encoded "=46rom " — still QP, decoding to the same text. A base64
//       part cannot hold a space, so it is still kept as written.
//   (b) an entity with bare-LF line ends had its body read as header fields. It is now normalised
//       to CRLF on the way in.
import { createTransferDecoder } from '@postroom/mime';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeArmor, parseKeys, pgpMimeSign, type OpenPgpKey } from '../../src/index.js';
import { canonicalizeForSigning, isSevenBitSafe } from '../../src/mime-write.js';
import { text } from './fixtures.js';

const decodeQp = (b: Buffer): Buffer => {
  const d = createTransferDecoder('quoted-printable');
  return Buffer.concat([d.write(b), d.end()]);
};
const split = (b: Buffer): { head: string; body: Buffer } => {
  const at = b.indexOf('\r\n\r\n');
  expect(at).toBeGreaterThan(0);
  return { head: b.subarray(0, at).toString('latin1'), body: b.subarray(at + 4) };
};
/** What an mbox-writing relay does to a line that starts "From ". */
const mboxMunge = (b: Buffer): Buffer => Buffer.from(b.toString('latin1').replace(/(^|\r\n)From /g, '$1>From '), 'latin1');

describe('(a) an existing quoted-printable part with a line starting "From "', () => {
  const qpBody = 'Hello,\r\nFrom here on it is fine.\r\nsoft=\r\nFrom after a soft break\r\nend\r\n';
  const entity = Buffer.from(`Content-Type: text/plain; charset=us-ascii\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qpBody}`, 'latin1');

  it('re-encodes it "=46rom ": no line starts "From ", it decodes to exactly the same text, and the rest is byte for byte', () => {
    const c = canonicalizeForSigning(entity);
    const { head, body } = split(c);
    expect(head).toMatch(/Content-Transfer-Encoding: quoted-printable/);
    for (const line of body.toString('latin1').split('\r\n')) expect(line.startsWith('From ')).toBe(false);
    expect(body.toString('latin1')).toBe(qpBody.replace(/(^|\r\n)From /g, '$1=46rom '));
    expect(decodeQp(body)).toEqual(decodeQp(Buffer.from(qpBody, 'latin1')));
    expect(isSevenBitSafe(c)).toBe(true);
  });

  it('a signed entity is untouched by an mbox relay that rewrites "From " to ">From"', () => {
    const [key] = parseKeys(decodeArmor(text('alice-ed25519.TEST-ONLY.sec.asc'))?.data ?? Buffer.alloc(0)) as [OpenPgpKey];
    const signed = pgpMimeSign(entity, key, { created: new Date('2026-09-26T10:00:00Z') });
    expect(mboxMunge(signed.body)).toEqual(signed.body);
  });

  it('a QP line near 76 characters that would overflow once escaped is decoded and re-encoded instead (same text, lines ≤ 76)', () => {
    const long = `From ${'y'.repeat(70)}`;
    const e = Buffer.from(`Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${long}\r\n`, 'latin1');
    const { body } = split(canonicalizeForSigning(e));
    for (const line of body.toString('latin1').split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
      expect(line.startsWith('From ')).toBe(false);
    }
    expect(decodeQp(body).toString('latin1')).toBe(`${long}\r\n`);
  });

  it('a QP part without such a line is still kept byte for byte, and base64 is unchanged', () => {
    expect(canonicalizeForSigning(Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nplain=20\r\nlines\r\n', 'latin1')).toString('latin1')).toBe(
      'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nplain=20\r\nlines\r\n',
    );
    const b64 = `Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('From me').toString('base64')}\r\n`;
    expect(canonicalizeForSigning(Buffer.from(b64, 'latin1')).toString('latin1')).toBe(b64);
  });

  it('property: any QP-safe body keeps decoding to the same bytes and never has a line starting "From "', () => {
    const line = fc.oneof(fc.constant('From x'), fc.constant('From '), fc.stringMatching(/^[A-Za-z .]{0,60}$/)).map((l) => l.replace(/[ ]+$/, ''));
    fc.assert(
      fc.property(fc.array(line, { maxLength: 12 }), (lines) => {
        const body = `${lines.join('\r\n')}\r\n`;
        const e = Buffer.from(`Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${body}`, 'latin1');
        const out = split(canonicalizeForSigning(e)).body;
        expect(decodeQp(out)).toEqual(decodeQp(Buffer.from(body, 'latin1')));
        for (const l of out.toString('latin1').split('\r\n')) expect(l.startsWith('From ')).toBe(false);
      }),
    );
  });
});

describe('(b) an entity with bare-LF line ends', () => {
  it('is normalised to CRLF: the body stays the body, the header fields stay header fields', () => {
    const lf = Buffer.from('Content-Type: text/plain; charset=us-ascii\nContent-Transfer-Encoding: 7bit\n\nFirst line\nsecond line\n', 'latin1');
    const c = canonicalizeForSigning(lf);
    const { head, body } = split(c);
    expect(head).toBe('Content-Type: text/plain; charset=us-ascii\r\nContent-Transfer-Encoding: quoted-printable');
    expect(head).not.toContain('First line');
    expect(decodeQp(body).toString('latin1')).toBe('First line\r\nsecond line\r\n');
    expect(c.toString('latin1')).not.toMatch(/(?<!\r)\n/);
    expect(isSevenBitSafe(c)).toBe(true);
  });

  it('gives the same result as the CRLF form, for a multipart too', () => {
    const crlf = 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nOne\r\n--b\r\nContent-Type: text/plain\r\n\r\nTwo\r\n--b--\r\n';
    const lf = crlf.replace(/\r\n/g, '\n');
    expect(canonicalizeForSigning(Buffer.from(lf, 'latin1'))).toEqual(canonicalizeForSigning(Buffer.from(crlf, 'latin1')));
  });

  it('an entity already in CRLF is unchanged by the normalisation', () => {
    const crlf = Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nok\r\n', 'latin1');
    expect(canonicalizeForSigning(crlf)).toEqual(crlf);
  });
});
