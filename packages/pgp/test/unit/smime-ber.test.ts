// PST-T-12.4, PST-REQ-160: S/MIME interop with BER. `openssl cms -stream` (as Thunderbird/NSS send)
// writes indefinite lengths and constructed OCTET STRINGs; each such fixture verifies or decrypts
// with the same status as its DER twin (make-fixtures.sh SECTIONS=smime-ber). Strict DER stays for
// the bytes a signature covers: signed attributes and certificates. A malformed enveloped-data part
// is failed:<reason>, never not-encrypted. Several SignerInfos follow one explicit rule.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { analyzeMessage, BerError, children, DerError, encodeTlv, MAX_INDEFINITE_DEPTH, NotDerError, octets, parseContentInfo, parseSignedData, readAll, readTlv, type Tlv } from '../../src/index.js';
import { carol, chunked, fixture, tamper } from './fixtures.js';
import { forgeCert, signedDataOf, signerInfo, smimeSigned, SIGNED_PART, type ForgedCert } from './forge.js';

const NOW = new Date('2026-06-01T00:00:00Z');

/** The base64 CMS body of a fixture's S/MIME part, decoded. */
function cmsOf(name: string): Buffer {
  const eml = fixture(name).toString('latin1');
  const m = /Content-Type: application\/(?:x-)?pkcs7-(?:signature|mime)[^]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(eml);
  return Buffer.from((m?.[1] ?? '').replace(/\s+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------------------------
// A BER re-encoder for tests: every constructed value indefinite, every primitive length in a
// padded long form, except the values `keepDer` names, which are copied as they are.

function berify(t: Tlv, keepDer: (t: Tlv) => boolean = () => false): Buffer {
  if (keepDer(t)) return Buffer.from(t.raw);
  const id = t.raw.subarray(0, idLength(t.raw));
  if (t.constructed) return Buffer.concat([id, Buffer.of(0x80), ...children(t).map((c) => berify(c, keepDer)), Buffer.of(0, 0)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(t.content.length, 0);
  return Buffer.concat([id, Buffer.of(0x84), len, t.content]);
}

/** The identifier octets' length (X.690 §8.1.2): one, or a high-tag-number run. */
function idLength(raw: Buffer): number {
  if (((raw[0] ?? 0) & 0x1f) !== 0x1f) return 1;
  let n = 1;
  while (((raw[n] ?? 0) & 0x80) !== 0) n++;
  return n + 1;
}

const sameBytes = (a: Buffer) => (t: Tlv): boolean => Buffer.from(t.raw).equals(a);

describe('BER fixtures from openssl 3.6 cms -stream have the same status as their DER twins', () => {
  it('the BER fixtures really are BER (and the DER twins DER)', () => {
    for (const kind of ['detached', 'opaque', 'encrypted']) {
      expect(() => readTlv(cmsOf(`smime-ber-${kind}.eml`)), kind).toThrow(NotDerError);
      expect(readTlv(cmsOf(`smime-ber-${kind}.eml`), 0, 0, 'ber').indefinite).toBe(true);
      expect(readTlv(cmsOf(`smime-der-${kind}.eml`)).indefinite).toBe(false);
    }
    // The opaque content is a constructed OCTET STRING (segments), joined back into the entity.
    const sd = parseSignedData(parseContentInfo(cmsOf('smime-ber-opaque.eml')).content);
    expect(sd.eContent?.toString('latin1')).toContain('This message was signed as a stream.');
  });

  it('detached (multipart/signed, BER p7s): verified-known-key / valid-signature-unknown-key / bad-signature, as the DER twin', async () => {
    for (const mode of ['der', 'ber']) {
      const name = `smime-${mode}-detached.eml`;
      expect((await analyzeMessage(chunked(fixture(name)), [carol('contact')])).signature, name).toMatchObject({ status: 'verified-known-key', format: 'smime' });
      expect((await analyzeMessage([fixture(name)], [])).signature.status, name).toBe('valid-signature-unknown-key');
      expect((await analyzeMessage([tamper(fixture(name), 'signed as a stream')], [carol('contact')])).signature.status, name).toBe('bad-signature');
    }
  });

  it('opaque (application/pkcs7-mime; smime-type=signed-data, BER): the same as the DER twin', async () => {
    for (const mode of ['der', 'ber']) {
      const name = `smime-${mode}-opaque.eml`;
      const r = await analyzeMessage(chunked(fixture(name), 61), [carol('contact')]);
      expect(r.signature, name).toMatchObject({ status: 'verified-known-key', format: 'smime-opaque' });
      expect(r.encryption.status, name).toBe('not-encrypted');
      expect((await analyzeMessage([fixture(name)], [])).signature.status, name).toBe('valid-signature-unknown-key');
    }
  });

  it('enveloped (cms -encrypt -stream, BER, constructed encryptedContent): decrypts as the DER twin, and no-key without the key', async () => {
    for (const mode of ['der', 'ber']) {
      const name = `smime-${mode}-encrypted.eml`;
      const r = await analyzeMessage(chunked(fixture(name), 29), [carol('own', true)]);
      expect(r.encryption, name).toMatchObject({ status: 'decrypted', format: 'smime', cipher: 'AES-256-CBC', openedWithKeyId: 'carol-own' });
      expect((await analyzeMessage([fixture(name)], [])).encryption.status, name).toBe('no-key');
    }
  });
});

describe('BER wrappers, strict DER for signed bytes (forged)', () => {
  const cert = forgeCert();
  const der = signedDataOf([signerInfo(cert, SIGNED_PART)], [cert.der]);
  const top = readTlv(der);
  const signedAttrsOf = (t: Tlv): Buffer => {
    const sd = parseSignedData(parseContentInfo(Buffer.from(t.raw)).content);
    const a = sd.signers[0]?.signedAttrs;
    if (a === undefined || a === null) throw new Error('no signed attributes');
    return Buffer.from(a.raw);
  };
  const attrs = signedAttrsOf(top);

  it('a detached SignedData (no eContent) with every wrapper BER, certificate and signed attributes DER, verifies', async () => {
    const ber = berify(top, (t) => sameBytes(cert.der)(t) || sameBytes(attrs)(t));
    expect(() => readTlv(ber)).toThrow(NotDerError);
    const r = await analyzeMessage([smimeSigned(SIGNED_PART, ber)], [cert.known()], { now: NOW });
    expect(r.signature.status).toBe('verified-known-key');
  });

  it('BER signed attributes → unsupported:signed-attributes-not-der (the bytes signed must be one encoding)', async () => {
    const ber = berify(top, sameBytes(cert.der));
    const r = await analyzeMessage([smimeSigned(SIGNED_PART, ber)], [cert.known()], { now: NOW });
    expect(r.signature.status).toBe('unsupported:signed-attributes-not-der');
  });

  it('a BER certificate → unsupported:ber-encoding (a TBSCertificate is DER or nothing)', async () => {
    const ber = berify(top, sameBytes(attrs));
    const r = await analyzeMessage([smimeSigned(SIGNED_PART, ber)], [cert.known()], { now: NOW });
    expect(r.signature.status).toBe('unsupported:ber-encoding');
  });
});

describe('a malformed enveloped-data part is failed:<reason>, never not-encrypted', () => {
  const head = (ct: string): string => `From: Dave <dave@example.test>\r\nTo: Carol Test <carol@example.test>\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: ${ct}\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  const body = (b: Buffer): string => `${b.toString('base64').replace(/(.{64})/g, '$1\r\n')}\r\n`;
  const ber = cmsOf('smime-ber-encrypted.eml');

  for (const [label, ct] of [
    ['smime-type=enveloped-data', 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"'],
    ['x-pkcs7-mime, authEnveloped-data', 'application/x-pkcs7-mime; smime-type=authEnveloped-data'],
    ['no smime-type, .p7m name', 'application/pkcs7-mime; name=smime.p7m'],
  ] as const) {
    it(`${label}: truncated BER, garbage, and a missing end-of-contents all fail by name`, async () => {
      for (const bytes of [ber.subarray(0, Math.floor(ber.length / 2)), Buffer.from('not a CMS structure at all'), ber.subarray(0, ber.length - 2), Buffer.alloc(0)]) {
        const r = await analyzeMessage([Buffer.from(head(ct) + body(bytes), 'latin1')], [carol('own', true)]);
        expect(r.encryption.status).toMatch(/^failed:/);
        expect(r.encryption.format).toBe('smime');
        expect(r.signature.status).toBe('not-signed');
      }
    });
  }

  it('a well-formed enveloped body under the same headers still decrypts; smime-type=signed-data garbage is a signature problem', async () => {
    const ok = await analyzeMessage([Buffer.from(head('application/pkcs7-mime; smime-type=enveloped-data') + body(ber), 'latin1')], [carol('own', true)]);
    expect(ok.encryption.status).toBe('decrypted');
    const signed = await analyzeMessage([Buffer.from(head('application/pkcs7-mime; smime-type=signed-data; name=smime.p7m') + body(Buffer.from('garbage')), 'latin1')], []);
    expect(signed.encryption.status).toBe('not-encrypted');
    expect(signed.signature.status).toMatch(/^unsupported:malformed-/);
  });

  it('the real BER fixture with one byte of its encrypted content cut is failed, not not-encrypted', async () => {
    const eml = fixture('smime-ber-encrypted.eml').toString('latin1');
    const cut = eml.replace(/(\r?\n\r?\n)([A-Za-z0-9+/]{64}\r?\n)/, '$1');
    const r = await analyzeMessage([Buffer.from(cut, 'latin1')], [carol('own', true)]);
    expect(r.encryption.status).toMatch(/^failed:/);
  });
});

describe('several SignerInfos: bad anywhere → bad-signature; else verified if any is; else the worst', () => {
  const known = forgeCert({ cn: 'Known Signer (TEST ONLY)', serial: Buffer.of(0x11) });
  const other = forgeCert({ cn: 'Other Signer (TEST ONLY)', serial: Buffer.of(0x22) });
  const status = async (sis: Buffer[], certs: ForgedCert[], ring: ForgedCert[]): Promise<{ status: string; reasons: string[] }> => {
    const r = await analyzeMessage([smimeSigned(SIGNED_PART, signedDataOf(sis, certs.map((c) => c.der)))], ring.map((c) => c.known({ id: c === known ? 'known' : 'other' })), { now: NOW });
    return { status: r.signature.status, reasons: r.signature.reasons };
  };
  const valid = signerInfo(known, SIGNED_PART);
  const bogus = signerInfo(other, SIGNED_PART, { bogus: true });
  const bogusKnown = signerInfo(known, SIGNED_PART, { bogus: true });
  const unresolvable = signerInfo(other, SIGNED_PART);
  const sha1 = signerInfo(other, SIGNED_PART, { digest: 'sha1' });

  it('bogus-then-valid and valid-then-bogus are both bad-signature', async () => {
    for (const order of [[bogus, valid], [valid, bogus]]) {
      const r = await status(order, [known, other], [known]);
      expect(r.status).toBe('bad-signature');
      expect(r.reasons.join(' ')).toMatch(/SignerInfo \d of 2: it does not verify/);
    }
    // Even when the bad one is by the known certificate itself.
    for (const order of [[bogusKnown, valid], [valid, bogusKnown]]) expect((await status(order, [known], [known])).status).toBe('bad-signature');
  });

  it('an uncheckable SignerInfo (its certificate unavailable) does not hide a valid known one, in either order', async () => {
    for (const order of [[unresolvable, valid], [valid, unresolvable]]) {
      const r = await status(order, [known], [known]);
      expect(r.status).toBe('verified-known-key');
      expect(r.reasons.join(' ')).toMatch(/SignerInfo \d of 2: it verifies with a known certificate/);
    }
  });

  it('with no known signer, the worst is reported: unsupported before valid-signature-unknown-key, in either order', async () => {
    for (const order of [[sha1, valid], [valid, sha1]]) expect((await status(order, [known, other], [])).status).toBe('unsupported:weak-hash-sha1');
    expect((await status([valid, valid], [known], [])).status).toBe('valid-signature-unknown-key');
  });

  it('one SignerInfo reads exactly as before (no position note)', async () => {
    const r = await status([valid], [known], [known]);
    expect(r.status).toBe('verified-known-key');
    expect(r.reasons.join(' ')).not.toMatch(/SignerInfo/);
  });
});

describe('the BER reader', () => {
  it('reads indefinite lengths, padded long-form lengths, and joins constructed OCTET STRING segments', () => {
    const inner = encodeTlv(0, false, 4, Buffer.from('abc'));
    const ber = Buffer.concat([Buffer.of(0x24, 0x80), inner, Buffer.of(0x24, 0x80), encodeTlv(0, false, 4, Buffer.from('de')), Buffer.of(0, 0), Buffer.of(0x04, 0x82, 0x00, 0x01), Buffer.from('f'), Buffer.of(0, 0)]);
    const t = readTlv(ber, 0, 0, 'ber');
    expect(t.raw.length).toBe(ber.length);
    expect(octets(t).toString('latin1')).toBe('abcdef');
    expect(() => readTlv(ber)).toThrow(NotDerError);
  });

  it('refuses malformed BER with BerError (still a DerError)', () => {
    const cases: Buffer[] = [
      Buffer.of(0x30, 0x80, 0x04, 0x01, 0x41), // no end-of-contents
      Buffer.of(0x04, 0x80, 0x41, 0x00, 0x00), // indefinite primitive
      Buffer.of(0x30, 0x04, 0x00, 0x00, 0x05, 0x00), // end-of-contents inside a definite value
      // MAX_INDEFINITE_DEPTH + 1 nested indefinite SEQUENCEs.
      Buffer.concat([Buffer.from(Array.from({ length: MAX_INDEFINITE_DEPTH + 1 }, () => [0x30, 0x80]).flat()), Buffer.alloc((MAX_INDEFINITE_DEPTH + 1) * 2)]),
    ];
    for (const c of cases) expect(() => children(readTlv(c, 0, 0, 'ber'))).toThrow(BerError);
    expect(new BerError('x')).toBeInstanceOf(DerError);
    // One level less deep is fine.
    const ok = Buffer.concat([Buffer.from(Array.from({ length: MAX_INDEFINITE_DEPTH }, () => [0x30, 0x80]).flat()), Buffer.alloc(MAX_INDEFINITE_DEPTH * 2)]);
    expect(readTlv(ok, 0, 0, 'ber').raw.length).toBe(ok.length);
    // A constructed OCTET STRING segment must be an OCTET STRING.
    expect(() => octets(readTlv(Buffer.of(0x24, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00), 0, 0, 'ber'))).toThrow(DerError);
  });

  // Generated trees, encoded as BER (random indefinite and padded lengths), read back to the same tree.
  type Node = { tag: number; value: Uint8Array } | { tag: number; kids: Node[] };
  const nodeArb: fc.Arbitrary<Node> = fc.letrec<{ node: Node }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.record({ tag: fc.integer({ min: 1, max: 30 }), value: fc.uint8Array({ maxLength: 200 }) }),
      fc.record({ tag: fc.integer({ min: 1, max: 30 }), kids: fc.array(tie('node'), { maxLength: 4 }) }),
    ),
  })).node;
  const encodeBer = (n: Node, choice: () => boolean): Buffer => {
    if ('value' in n) {
      if (!choice()) return encodeTlv(2, false, n.tag, n.value);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(n.value.length, 0);
      return Buffer.concat([Buffer.of(0x80 | n.tag, 0x84), len, n.value]);
    }
    const inner = Buffer.concat(n.kids.map((k) => encodeBer(k, choice)));
    return choice() ? Buffer.concat([Buffer.of(0xa0 | n.tag, 0x80), inner, Buffer.of(0, 0)]) : encodeTlv(2, true, n.tag, inner);
  };
  const decode = (t: Tlv): Node => (t.constructed ? { tag: t.tag, kids: children(t).map(decode) } : { tag: t.tag, value: new Uint8Array(t.content) });
  const norm = (n: Node): Node => ('value' in n ? { tag: n.tag, value: new Uint8Array(n.value) } : { tag: n.tag, kids: n.kids.map(norm) });

  it('round-trips generated trees encoded with indefinite and padded lengths; DER reads the same in BER mode', () => {
    fc.assert(
      fc.property(nodeArb, fc.array(fc.boolean(), { minLength: 1, maxLength: 64 }), (tree, bits) => {
        let i = 0;
        const choice = (): boolean => bits[i++ % bits.length] ?? false;
        const ber = encodeBer(tree, choice);
        const t = readTlv(ber, 0, 0, 'ber');
        expect(t.raw.length).toBe(ber.length);
        expect(decode(t)).toEqual(norm(tree));
        const der = encodeBer(tree, () => false);
        expect(decode(readTlv(der, 0, 0, 'ber'))).toEqual(decode(readTlv(der)));
      }),
    );
  });

  it('never throws anything but DerError on random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        try {
          for (const t of readAll(Buffer.from(bytes), 0, 100_000, 'ber')) if (t.constructed) octets(t);
        } catch (err) {
          expect(err).toBeInstanceOf(DerError);
        }
      }),
      { numRuns: 3000 },
    );
  });
});
