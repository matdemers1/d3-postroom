import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateDkimKeys,
  headerHashInput,
  MAX_LINE,
  parseSignatureField,
  signMessage,
  splitMessage,
  verifyLocal,
  withEmptyB,
  type DkimSigningKey,
  type SignOptions,
} from '../../src/index.js';

const { rsa, ed25519 } = generateDkimKeys();
const NOW = new Date('2026-09-25T12:00:00Z');
const signingKeys: DkimSigningKey[] = [
  { selector: 'pr202609r', algorithm: 'rsa-sha256', privateKey: rsa.privateKey },
  { selector: 'pr202609e', algorithm: 'ed25519-sha256', privateKey: ed25519.privateKey },
];
const verifyKeys = new Map([
  ['pr202609r', rsa.publicKey],
  ['pr202609e', ed25519.publicKey],
]);

const MESSAGE = [
  'From: Matt <matt@d3cloud.io>',
  'To: Someone <someone@gmail.example>',
  'Cc: other@example.net',
  'Subject: Dinner  on\tFriday',
  'Date: Thu, 25 Sep 2026 12:00:00 +0000',
  'Message-ID: <abc123@d3cloud.io>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'X-Unsigned: not in the list',
  '',
  'Hello there.  ',
  '',
  'Line with\ttabs and  spaces',
  '',
  '',
].join('\r\n');

async function signed(msg = MESSAGE, extra: Partial<SignOptions> = {}): Promise<string> {
  const sigs = await signMessage(Buffer.from(msg, 'latin1'), { domain: 'd3cloud.io', keys: signingKeys, now: NOW, ...extra });
  return sigs.join('') + msg;
}

async function results(msg: string): Promise<string[]> {
  return (await verifyLocal(Buffer.from(msg, 'latin1'), verifyKeys)).map((r) => `${r.algorithm ?? '?'}:${r.result}`);
}

const BOTH_PASS = ['ed25519-sha256:pass', 'rsa-sha256:pass'];
const BOTH_FAIL = ['ed25519-sha256:fail', 'rsa-sha256:fail'];

describe('signMessage', () => {
  it('produces an Ed25519 then an RSA signature that the local verifier passes', async () => {
    const sigs = await signMessage(Buffer.from(MESSAGE, 'latin1'), { domain: 'd3cloud.io', keys: signingKeys, now: NOW });
    expect(sigs).toHaveLength(2);
    const [ed, rs] = sigs.map((s) => parseSignatureField(s.slice(0, -2)));
    expect(ed?.algorithm).toBe('ed25519-sha256');
    expect(rs?.algorithm).toBe('rsa-sha256');
    expect(await results(sigs.join('') + MESSAGE)).toEqual(BOTH_PASS);
  });

  it('writes the expected tags, oversigns From, and shares one bh=', async () => {
    const sigs = await signMessage(Buffer.from(MESSAGE, 'latin1'), { domain: 'd3cloud.io', keys: signingKeys, now: NOW });
    for (const s of sigs) {
      const p = parseSignatureField(s.slice(0, -2));
      expect(p.domain).toBe('d3cloud.io');
      expect(`${p.headerCanon}/${p.bodyCanon}`).toBe('relaxed/relaxed');
      expect(p.signedHeaders).toEqual([
        'from', 'from', 'to', 'cc', 'subject', 'date', 'message-id', 'mime-version', 'content-type',
      ]);
      expect(s).toContain(`t=${Math.floor(NOW.getTime() / 1000)};`);
      expect(s.startsWith('DKIM-Signature: v=1; a=')).toBe(true);
      expect(/; *\r?\n?\t?b=[A-Za-z0-9+/=\r\n\t]+\r\n$/.test(s)).toBe(true); // b= last
    }
    const bh = sigs.map((s) => parseSignatureField(s.slice(0, -2)).bodyHash.toString('base64'));
    expect(bh[0]).toBe(bh[1]);
  });

  it('folds every line at <= 78 characters with CRLF + TAB', async () => {
    const sigs = await signMessage(Buffer.from(MESSAGE, 'latin1'), { domain: 'd3cloud.io', keys: signingKeys, now: NOW });
    for (const s of sigs) {
      const lines = s.slice(0, -2).split('\r\n');
      expect(lines.length).toBeGreaterThan(1);
      for (const [i, line] of lines.entries()) {
        expect(line.length).toBeLessThanOrEqual(MAX_LINE);
        if (i > 0) expect(line.startsWith('\t')).toBe(true);
      }
      expect(s.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    }
  });

  it('streams: a Readable in small chunks signs identically to a Buffer', async () => {
    const buf = Buffer.from(MESSAGE, 'latin1');
    const chunks = Array.from({ length: Math.ceil(buf.length / 7) }, (_, i) => buf.subarray(i * 7, i * 7 + 7));
    const fromStream = await signMessage(Readable.from(chunks), { domain: 'd3cloud.io', keys: signingKeys, now: NOW });
    const fromBuffer = await signMessage(buf, { domain: 'd3cloud.io', keys: signingKeys, now: NOW });
    // Ed25519 and RSA PKCS#1 v1.5 are deterministic, so the fields are identical.
    expect(fromStream).toEqual(fromBuffer);
  });

  it('signs an empty body and a body-less message', async () => {
    expect(await results(await signed('From: a@d3cloud.io\r\nSubject: x\r\n\r\n'))).toEqual(BOTH_PASS);
    expect(await results(await signed('From: a@d3cloud.io\r\n'))).toEqual(BOTH_PASS);
  });

  it('rejects: no From, a short RSA key, a wrong key type, a bad domain', async () => {
    const opts = { domain: 'd3cloud.io', keys: signingKeys, now: NOW };
    await expect(signMessage(Buffer.from('Subject: x\r\n\r\nbody'), opts)).rejects.toThrow(/no From/);
    const short = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    await expect(
      signMessage(Buffer.from(MESSAGE), { ...opts, keys: [{ selector: 's', algorithm: 'rsa-sha256', privateKey: short }] }),
    ).rejects.toThrow(/2048/);
    await expect(
      signMessage(Buffer.from(MESSAGE), {
        ...opts,
        keys: [{ selector: 's', algorithm: 'rsa-sha256', privateKey: ed25519.privateKey }],
      }),
    ).rejects.toThrow(/rsa key/);
    await expect(signMessage(Buffer.from(MESSAGE), { ...opts, domain: 'd3cloud.io;\r\nX: y' })).rejects.toThrow(
      /domain/,
    );
    await expect(
      signMessage(Buffer.from(MESSAGE), { ...opts, keys: [{ selector: 'a;b', algorithm: 'rsa-sha256', privateKey: rsa.privateKey }] }),
    ).rejects.toThrow(/selector/);
  });
});

describe('mutations', () => {
  it('a changed Subject fails both', async () => {
    const msg = await signed();
    expect(await results(msg.replace('Subject: Dinner', 'Subject: Lunch'))).toEqual(BOTH_FAIL);
  });

  it('a changed body fails both', async () => {
    const msg = await signed();
    expect(await results(msg.replace('Hello there.', 'Hello there!'))).toEqual(BOTH_FAIL);
  });

  it('an added From fails both (oversigning), above or below the original', async () => {
    const msg = await signed();
    const above = msg.replace('From: Matt', 'From: Mallory <m@evil.example>\r\nFrom: Matt');
    expect(await results(above)).toEqual(BOTH_FAIL);
    const below = msg.replace('To: Someone', 'From: Mallory <m@evil.example>\r\nTo: Someone');
    expect(await results(below)).toEqual(BOTH_FAIL);
  });

  it('an added unsigned header does not break the signatures', async () => {
    const msg = await signed();
    expect(await results(msg.replace('X-Unsigned:', 'Received: from somewhere\r\nX-Unsigned:'))).toEqual(BOTH_PASS);
  });

  it('relaxed tolerates whitespace re-folding and trailing whitespace', async () => {
    const msg = await signed();
    const refolded = msg
      .replace('Subject: Dinner  on\tFriday', 'Subject:   Dinner\r\n\ton    Friday  ')
      .replace('Line with\ttabs and  spaces', 'Line with tabs   and \t spaces   ')
      .replace('Hello there.  \r\n', 'Hello there.\r\n');
    expect(refolded).not.toBe(msg);
    expect(await results(`${refolded}\r\n\r\n`)).toEqual(BOTH_PASS);
  });

  it('simple fails on a trailing space added inside a line; relaxed does not', async () => {
    const simple = await signed(MESSAGE, { canonicalization: 'simple/simple' });
    expect(await results(simple)).toEqual(BOTH_PASS);
    expect(await results(simple.replace('Line with\ttabs', 'Line with \ttabs'))).toEqual(BOTH_FAIL);
    expect(await results(simple.replace('Hello there.  \r\n', 'Hello there.   \r\n'))).toEqual(BOTH_FAIL);
    const relaxed = await signed();
    expect(await results(relaxed.replace('Hello there.  \r\n', 'Hello there.   \r\n'))).toEqual(BOTH_PASS);
  });

  it('a signature checked with the other selector key is not a pass', async () => {
    const msg = await signed();
    const swapped = new Map([
      ['pr202609r', ed25519.publicKey],
      ['pr202609e', rsa.publicKey],
    ]);
    const res = await verifyLocal(Buffer.from(msg, 'latin1'), swapped);
    expect(res.map((r) => r.result)).toEqual(['permerror', 'permerror']);
  });
});

// Cross-check with an independent implementation when openssl is on PATH.
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

describe.skipIf(!hasOpenssl)('openssl cross-check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'postroom-dkim-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function canonicalData(msg: string, index: number): Promise<{ data: Buffer; sig: Buffer }> {
    const split = await splitMessage(Buffer.from(msg, 'latin1'));
    const field = split.fields.filter((f) => f.key === 'dkim-signature')[index];
    if (field === undefined) throw new Error('no signature');
    const raw = field.raw.toString('latin1');
    const p = parseSignatureField(raw);
    return { data: headerHashInput(split.fields, p.signedHeaders, withEmptyB(raw), 'relaxed'), sig: p.signature };
  }

  it('openssl dgst -sha256 -verify accepts the RSA b= over the canonical header data', async () => {
    const msg = await signed();
    const { data, sig } = await canonicalData(msg, 1);
    writeFileSync(join(dir, 'rsa.pem'), rsa.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(join(dir, 'rsa.data'), data);
    writeFileSync(join(dir, 'rsa.sig'), sig);
    const out = execFileSync('openssl', [
      'dgst', '-sha256', '-verify', join(dir, 'rsa.pem'), '-signature', join(dir, 'rsa.sig'), join(dir, 'rsa.data'),
    ]).toString();
    expect(out.trim()).toBe('Verified OK');
  });

  it('openssl pkeyutl accepts the Ed25519 b= over SHA-256 of the canonical header data', async () => {
    const msg = await signed();
    const { data, sig } = await canonicalData(msg, 0);
    const { createHash } = await import('node:crypto');
    writeFileSync(join(dir, 'ed.pem'), ed25519.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(join(dir, 'ed.digest'), createHash('sha256').update(data).digest());
    writeFileSync(join(dir, 'ed.sig'), sig);
    const out = execFileSync('openssl', [
      'pkeyutl', '-verify', '-pubin', '-inkey', join(dir, 'ed.pem'), '-rawin',
      '-in', join(dir, 'ed.digest'), '-sigfile', join(dir, 'ed.sig'),
    ]).toString();
    expect(out).toMatch(/Signature Verified Successfully/);
  });
});
