// PST-T-12.6, PST-REQ-161: what the verifier of PST-T-12.2 found, fixed at the writer.
//   (1) a signed entity is made 7bit-safe before it is signed — text parts quoted-printable, so a
//       relay that strips trailing whitespace or re-wraps long lines cannot break the signature
//       (RFC 3156 §3, RFC 8551 §3.1.1): gpg --verify and openssl cms -verify pass after the strip;
//   (2) a forward's message/rfc822 part inside a signed entity is 7bit too (its own parts
//       re-encoded), or message/global in base64 when its header fields are 8-bit (RFC 6532 §3.5);
//   (3) OpenPGP recipients can be hidden: a PKESK with the wildcard key ID (RFC 9580 §5.1) names
//       no one, and gpg still decrypts with the hidden recipient's TEST key.
import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTransferDecoder } from '@postroom/mime';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { certificatesFromPem, decodeArmor, decryptMessage, entityBytes, parseKeys, pgpMimeEncrypt, pgpMimeSign, readPackets, smimeSign, Tag, type OpenPgpKey } from '../../src/index.js';
import { canonicalizeForSigning, encodeQuotedPrintableSafe, isSevenBitSafe } from '../../src/mime-write.js';
import { WILDCARD_KEY_ID } from '../../src/write.js';
import { FIXTURES, text } from './fixtures.js';

function tool(name: string): string | null {
  const brew = `/opt/homebrew/bin/${name}`;
  if (existsSync(brew)) return brew;
  const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  const path = found.status === 0 ? found.stdout.trim() : '';
  if (path === '') return null;
  return name === 'openssl' && !spawnSync(path, ['version'], { encoding: 'utf8' }).stdout.startsWith('OpenSSL 3') ? null : path;
}
const GPG = tool('gpg');
const OPENSSL = tool('openssl');
if (GPG === null) process.stderr.write('hardening-12-6: gpg not found — skipping the gpg interop tests\n');
if (OPENSSL === null) process.stderr.write('hardening-12-6: OpenSSL 3 not found — skipping the openssl cms interop tests\n');

const dirs: string[] = [];
afterAll(() => {
  const gpgconf = GPG === null ? null : join(GPG, '..', 'gpgconf');
  for (const d of dirs) {
    if (gpgconf !== null && existsSync(gpgconf)) spawnSync(gpgconf, ['--homedir', d, '--kill', 'all']);
    rmSync(d, { recursive: true, force: true });
  }
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'pst-t126-'));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

const pub = (file: string): OpenPgpKey => {
  const [k] = parseKeys(decodeArmor(text(file))?.data ?? Buffer.alloc(0));
  if (k === undefined) throw new Error(file);
  return k;
};
const sec = (file: string): OpenPgpKey => {
  const [k] = parseKeys(decodeArmor(text(file))?.data ?? Buffer.alloc(0));
  if (k === undefined) throw new Error(file);
  return k;
};

const LONG = 'x'.repeat(900);
/** A text part with trailing spaces and tabs, a 900-character line, a line starting "From ", and one starting "--". */
const HOSTILE_BODY = `Trailing spaces here   \r\nand a tab\t\r\n${LONG}\r\nFrom the top\r\n--not a boundary\r\n.\r\nend\r\n`;
const ENTITY = Buffer.from(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${HOSTILE_BODY}`, 'latin1');
const HEAD = 'From: Zoe <zoe@example.test>\r\nTo: Alice <alice@example.test>\r\nSubject: relay\r\nDate: Sat, 26 Sep 2026 10:00:00 +0000\r\nMessage-ID: <r@example.test>\r\nMIME-Version: 1.0\r\n';

/** What a hostile relay does: every line loses its trailing whitespace. */
const stripTrailing = (b: Buffer): Buffer => Buffer.from(b.toString('latin1').replace(/[ \t]+\r\n/g, '\r\n'), 'latin1');

const decodeQp = (s: string): Buffer => {
  const d = createTransferDecoder('quoted-printable');
  return Buffer.concat([d.write(Buffer.from(s, 'latin1')), d.end()]);
};
const bodyAfterHead = (b: Buffer): Buffer => b.subarray(b.indexOf('\r\n\r\n') + 4);

describe('canonicalizeForSigning (RFC 3156 §3, RFC 8551 §3.1.1)', () => {
  it('re-encodes a 7bit text part quoted-printable: trailing whitespace encoded, lines ≤ 76, line starts escaped, decodes back exactly', () => {
    const c = canonicalizeForSigning(ENTITY);
    const s = c.toString('latin1');
    expect(s).toMatch(/^Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n/);
    expect(s).not.toMatch(/Content-Transfer-Encoding: 7bit/);
    expect(isSevenBitSafe(c)).toBe(true);
    expect(stripTrailing(c).equals(c)).toBe(true);
    for (const line of bodyAfterHead(c).toString('latin1').split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(s).toContain('Trailing spaces here  =20\r\n');
    expect(s).toContain('and a tab=09\r\n');
    expect(s).toContain('=46rom the top');
    expect(s).toContain('=2D-not a boundary');
    expect(decodeQp(bodyAfterHead(c).toString('latin1')).toString('latin1')).toBe(HOSTILE_BODY);
    // Idempotent: a canonical entity is already canonical.
    expect(canonicalizeForSigning(c).equals(c)).toBe(true);
  });

  it('property: any text body becomes 7bit-safe quoted-printable that decodes back byte for byte', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
        const entity = Buffer.concat([Buffer.from('Content-Type: text/plain\r\nContent-Transfer-Encoding: 8bit\r\n\r\n', 'latin1'), Buffer.from(bytes)]);
        const c = canonicalizeForSigning(entity);
        expect(isSevenBitSafe(c, 76)).toBe(true);
        expect(decodeQp(bodyAfterHead(c).toString('latin1')).equals(Buffer.from(bytes))).toBe(true);
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        const qp = encodeQuotedPrintableSafe(bytes);
        expect(isSevenBitSafe(Buffer.from(qp, 'latin1'), 76)).toBe(true);
        expect(decodeQp(qp).equals(Buffer.from(bytes))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('walks a multipart: each text part re-encoded, a base64 part kept, the preamble dropped, the boundary kept', () => {
    const b = '=_pr_test';
    const entity = Buffer.from(
      [
        `Content-Type: multipart/alternative;\r\n boundary="${b}"`,
        '',
        'preamble with trailing space ',
        `--${b}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        'plain  ',
        `--${b}`,
        'Content-Type: image/png',
        'Content-Transfer-Encoding: base64',
        '',
        'iVBORw0KGgo=',
        `--${b}--`,
        '',
      ].join('\r\n'),
      'latin1',
    );
    const c = canonicalizeForSigning(entity).toString('latin1');
    expect(c).not.toContain('preamble');
    expect(c).toContain(`--${b}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nplain =20\r\n--${b}\r\n`);
    expect(c).toContain(`Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--${b}--\r\n`);
    expect(isSevenBitSafe(Buffer.from(c, 'latin1'))).toBe(true);
  });

  it('a forward: message/rfc822 stays message/rfc822 and 7bit — its own 8bit text part re-encoded, no transfer encoding on it', () => {
    const b = '=_pr_fwd';
    const inner = `From: Ann <ann@example.test>\r\nSubject: original\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCafé crème  \r\n`;
    const entity = Buffer.concat([
      Buffer.from(`Content-Type: multipart/mixed;\r\n boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nSee below.\r\n\r\n--${b}\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forwarded-message.eml"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`, 'latin1'),
      Buffer.from(inner, 'utf8'),
      Buffer.from(`\r\n--${b}--\r\n`, 'latin1'),
    ]);
    const c = canonicalizeForSigning(entity);
    const s = c.toString('latin1');
    expect(isSevenBitSafe(c)).toBe(true);
    expect(s).toContain('Content-Type: message/rfc822\r\nContent-Disposition: attachment; filename="forwarded-message.eml"\r\n\r\nFrom: Ann <ann@example.test>\r\nSubject: original\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 cr=C3=A8me =20\r\n');
    expect(s).not.toContain('Content-Transfer-Encoding: 8bit');
  });

  it('a forward already 7bit-safe is kept byte for byte (its own DKIM signature still verifies)', () => {
    const b = '=_pr_keep';
    const inner = 'DKIM-Signature: v=1; a=rsa-sha256; d=example.test; s=x; bh=abc; b=def\r\nFrom: ann@example.test\r\nSubject: fine\r\nContent-Type: text/plain\r\n\r\nplain ascii\r\n';
    const entity = Buffer.from(`Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: message/rfc822\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${inner}\r\n--${b}--\r\n`, 'latin1');
    const s = canonicalizeForSigning(entity).toString('latin1');
    expect(s).toContain(`Content-Type: message/rfc822\r\n\r\n${inner}\r\n--${b}--`);
  });

  it('a forward with 8-bit header fields (RFC 6532) becomes message/global in base64, which decodes to the original bytes', () => {
    const b = '=_pr_intl';
    const inner = Buffer.from('From: Jürgen <j@example.test>\r\nSubject: Grüße\r\n\r\nHallo\r\n', 'utf8');
    const entity = Buffer.concat([Buffer.from(`Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: message/rfc822\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`, 'latin1'), inner, Buffer.from(`\r\n--${b}--\r\n`, 'latin1')]);
    const c = canonicalizeForSigning(entity);
    expect(isSevenBitSafe(c)).toBe(true);
    const s = c.toString('latin1');
    expect(s).toContain('Content-Type: message/global\r\nContent-Transfer-Encoding: base64\r\n\r\n');
    const part = s.slice(s.indexOf('Content-Type: message/global'));
    const b64 = part.slice(part.indexOf('\r\n\r\n') + 4, part.indexOf(`\r\n--${b}--`));
    expect(Buffer.from(b64.replace(/\r\n/g, ''), 'base64').equals(inner)).toBe(true);
  });
});

describe('hidden OpenPGP recipients: the wildcard key ID (RFC 9580 §5.1)', () => {
  const alice = pub('alice-ed25519.pub.asc');
  const bob = pub('bob-rsa3072.pub.asc');

  it('names the visible recipients, writes zeros for the hidden one, and the hidden one still decrypts', () => {
    const enc = pgpMimeEncrypt(ENTITY, [alice], { hidden: [bob] });
    expect(enc.recipients.map((r) => r.keyId)).toEqual([alice.subkeys[0]?.keyId, WILDCARD_KEY_ID]);
    expect(enc.recipients[1]).toMatchObject({ hidden: true });
    const armored = bodyAfterHead(entityBytes(enc)).toString('latin1');
    const block = decodeArmor(armored.slice(armored.indexOf('-----BEGIN PGP MESSAGE')));
    const ids = readPackets(block?.data ?? Buffer.alloc(0))
      .filter((p) => p.tag === Tag.PKESK)
      .map((p) => p.body.subarray(1, 9).toString('hex').toUpperCase());
    expect(ids).toHaveLength(2);
    expect(ids).toContain(WILDCARD_KEY_ID);
    for (const m of [bob.primary, ...bob.subkeys]) expect(ids).not.toContain(m.keyId);
    const bobSec = sec('bob-rsa3072.TEST-ONLY.sec.asc');
    const keys = [bobSec.primary, ...bobSec.subkeys].filter((m) => m.secretKey !== null).map((material) => ({ material, ref: 'bob' }));
    const out = decryptMessage(block?.data ?? Buffer.alloc(0), keys);
    expect(out.status).toBe('decrypted');
    expect(out.openedWith).toBe('bob');
    expect(out.plaintext?.equals(ENTITY)).toBe(true);
  });

  it.skipIf(GPG === null)('gpg decrypts a hidden-recipient PKESK with the TEST key (it tries its secret keys)', () => {
    for (const [secFile, hiddenKey] of [
      ['bob-rsa3072.TEST-ONLY.sec.asc', bob],
      ['alice-ed25519.TEST-ONLY.sec.asc', alice],
    ] as const) {
      const home = scratch();
      const gpg = (args: string[], input?: Buffer | string) => spawnSync(GPG ?? 'gpg', ['--homedir', home, '--batch', '--no-tty', '--pinentry-mode', 'loopback', ...args], { input, maxBuffer: 16 * 1024 * 1024 });
      expect(gpg(['--import', join(FIXTURES, secFile)]).status).toBe(0);
      const visible = hiddenKey === bob ? alice : bob;
      const enc = pgpMimeEncrypt(ENTITY, [visible], { hidden: [hiddenKey] });
      const armored = bodyAfterHead(entityBytes(enc)).toString('latin1');
      const out = gpg(['--decrypt'], armored.slice(armored.indexOf('-----BEGIN PGP MESSAGE'), armored.indexOf('-----END PGP MESSAGE-----') + 25));
      expect(out.status, out.stderr.toString()).toBe(0);
      expect(out.stderr.toString()).toMatch(/anonymous recipient/);
      expect(out.stdout.equals(ENTITY)).toBe(true);
    }
  });
});

describe('a signature survives a relay that strips trailing whitespace', () => {
  it.skipIf(GPG === null)('PGP/MIME: gpg --verify is still GOOD after every line loses its trailing whitespace', () => {
    const home = scratch();
    const gpg = (args: string[], input?: Buffer | string) => spawnSync(GPG ?? 'gpg', ['--homedir', home, '--batch', '--no-tty', '--pinentry-mode', 'loopback', ...args], { input, maxBuffer: 16 * 1024 * 1024 });
    expect(gpg(['--import', join(FIXTURES, 'alice-ed25519.TEST-ONLY.sec.asc')]).status).toBe(0);
    const signed = pgpMimeSign(ENTITY, sec('alice-ed25519.TEST-ONLY.sec.asc'));
    const relayed = stripTrailing(Buffer.concat([Buffer.from(HEAD, 'latin1'), entityBytes(signed)]));
    const boundary = /boundary="([^"]+)"/.exec(relayed.toString('latin1'))?.[1] ?? '';
    const pieces = relayed.toString('latin1').split(`--${boundary}`);
    const signedPart = Buffer.from((pieces[1] ?? '').replace(/^\r\n/, '').replace(/\r\n$/, ''), 'latin1');
    const sigPart = (pieces[2] ?? '').replace(/^\r\n/, '');
    const dir = scratch();
    writeFileSync(join(dir, 'part'), signedPart);
    writeFileSync(join(dir, 'part.asc'), sigPart.slice(sigPart.indexOf('-----BEGIN')));
    const v = gpg(['--status-fd', '1', '--verify', join(dir, 'part.asc'), join(dir, 'part')]);
    expect(v.status, v.stderr.toString()).toBe(0);
    expect(v.stdout.toString()).toContain('GOODSIG');

    // Control: the same strip over the un-canonicalized entity breaks a signature made over it.
    expect(stripTrailing(ENTITY).equals(ENTITY)).toBe(false);
  });

  it.skipIf(OPENSSL === null)('S/MIME: openssl cms -verify still succeeds after the strip', () => {
    const [carolCert] = certificatesFromPem(text('carol-smime.pem'));
    const [intermediate] = certificatesFromPem(text('smime-intermediate.pem'));
    if (carolCert === undefined || intermediate === undefined) throw new Error('fixtures');
    const e = smimeSign(ENTITY, { certificate: carolCert, privateKey: createPrivateKey(text('carol-smime.TEST-ONLY.key.pem')), chain: [intermediate] });
    const dir = scratch();
    const file = join(dir, 'signed.eml');
    writeFileSync(file, stripTrailing(Buffer.concat([Buffer.from(HEAD, 'latin1'), entityBytes(e)])));
    const v = spawnSync(OPENSSL ?? 'openssl', ['cms', '-verify', '-in', file, '-CAfile', join(FIXTURES, 'smime-root.pem'), '-purpose', 'smimesign', '-out', join(dir, 'out')]);
    expect(v.status, v.stderr.toString()).toBe(0);
    expect(v.stderr.toString()).toContain('Verification successful');
    expect(decodeQp(bodyAfterHead(readFileSync(join(dir, 'out'))).toString('latin1')).toString('latin1').replace(/\r\n/g, '\n')).toBe(HOSTILE_BODY.replace(/\r\n/g, '\n'));
  });
});
