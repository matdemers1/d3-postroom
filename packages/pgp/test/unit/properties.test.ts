// PST-T-12.1: fast-check properties for the hand-written formats — armor + radix-64 + CRC-24 round
// trip, the DER reader against the DER writer, and that every parser fails only with its own error
// type on arbitrary bytes. Plus: the signed-part hash does not depend on where chunks split.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analyzeMessage,
  ArmorError,
  crc24,
  decodeArmor,
  decodeOid,
  derSetOf,
  DerError,
  encodeArmor,
  encodeOid,
  encodePacket,
  encodeTlv,
  NotDerError,
  parseKeys,
  parseSignaturePacket,
  PgpError,
  radix64Decode,
  radix64Encode,
  readAll,
  readPackets,
  readTlv,
  type Tlv,
} from '../../src/index.js';
import { alice, bob, carol, fixture } from './fixtures.js';

describe('armor', () => {
  it('radix-64 round-trips and matches RFC 4648', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (bytes) => {
        const enc = radix64Encode(bytes);
        expect(enc).toBe(Buffer.from(bytes).toString('base64'));
        expect(Buffer.compare(radix64Decode(enc), Buffer.from(bytes))).toBe(0);
      }),
    );
  });

  it('CRC-24 matches the RFC 9580 reference value and is appended by encodeArmor', () => {
    expect(crc24(new Uint8Array())).toBe(0xb704ce);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 800 }), fc.constantFrom('PGP MESSAGE', 'PGP SIGNATURE', 'PGP PUBLIC KEY BLOCK'), (bytes, type) => {
        const text = encodeArmor(type, bytes, [['Comment', 'fast-check']]);
        const back = decodeArmor(text);
        expect(back?.type).toBe(type);
        expect(back?.checksum).toBe(true);
        expect(back?.headers).toEqual([['Comment', 'fast-check']]);
        expect(Buffer.compare(back?.data ?? Buffer.alloc(0), Buffer.from(bytes))).toBe(0);
      }),
    );
  });

  it('a corrupted checksum is refused', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 200 }), (bytes) => {
        const text = encodeArmor('PGP MESSAGE', bytes);
        const crcLine = /\n=([A-Za-z0-9+/]{4})\n/.exec(text)?.[1] ?? '';
        const other = radix64Encode(Uint8Array.of(((crc24(bytes) >>> 16) ^ 0x80) & 255, 0, 0)).slice(0, 4);
        const broken = text.replace(`=${crcLine}`, `=${other === crcLine ? 'AAAA' : other}`);
        if (broken === text) return;
        expect(() => decodeArmor(broken)).toThrow(ArmorError);
      }),
    );
  });

  it('arbitrary text never throws anything but ArmorError', () => {
    const armorish = fc.array(fc.oneof(fc.constantFrom('-----BEGIN PGP MESSAGE-----', '-----END PGP MESSAGE-----', '=abcd', 'Version: 1', '', 'AAAA', '====', '-----END PGP SIGNATURE-----'), fc.string({ maxLength: 40 })), { maxLength: 20 });
    fc.assert(
      fc.property(armorish, (lines) => {
        try {
          decodeArmor(lines.join('\n'));
        } catch (err) {
          expect(err).toBeInstanceOf(ArmorError);
        }
      }),
    );
  });
});

// A generated DER tree: leaves are primitive values, nodes are constructed with children.
type Node = { cls: number; tag: number; value: Uint8Array } | { cls: number; tag: number; kids: Node[] };

const tagArb = fc.oneof(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 31, max: 0x1fffff }));
const nodeArb: fc.Arbitrary<Node> = fc.letrec<{ node: Node }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.record({ cls: fc.integer({ min: 0, max: 3 }), tag: tagArb, value: fc.uint8Array({ maxLength: 300 }) }),
    fc.record({ cls: fc.integer({ min: 0, max: 3 }), tag: tagArb, kids: fc.array(tie('node'), { maxLength: 4 }) }),
  ),
})).node;

function encodeNode(n: Node): Buffer {
  if ('value' in n) return encodeTlv(n.cls, false, n.tag, n.value);
  return encodeTlv(n.cls, true, n.tag, Buffer.concat(n.kids.map(encodeNode)));
}

function decodeNode(t: Tlv): Node {
  if (!t.constructed) return { cls: t.tagClass, tag: t.tag, value: new Uint8Array(t.content) };
  return { cls: t.tagClass, tag: t.tag, kids: readAll(t.content).map(decodeNode) };
}

describe('DER reader', () => {
  it('round-trips generated TLV trees through the DER writer', () => {
    fc.assert(
      fc.property(nodeArb, (tree) => {
        const der = encodeNode(tree);
        const t = readTlv(der);
        expect(t.raw.length).toBe(der.length);
        expect(decodeNode(t)).toEqual(normalize(tree));
        expect(Buffer.compare(encodeNode(decodeNode(t)), der)).toBe(0);
      }),
    );
  });

  it('round-trips OIDs', () => {
    const oid = fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 39 }), fc.array(fc.nat({ max: 2 ** 32 }), { maxLength: 8 })).map(([a, b, rest]) => [a, b, ...rest].join('.'));
    fc.assert(
      fc.property(oid, (o) => {
        expect(decodeOid(encodeOid(o))).toBe(o);
      }),
    );
  });

  it('never throws anything but DerError on random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        try {
          const all = readAll(Buffer.from(bytes));
          for (const t of all) if (t.constructed) readAll(t.content);
        } catch (err) {
          expect(err).toBeInstanceOf(DerError);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it('refuses BER: an indefinite length, or a long-form length not in its shortest form, is NotDerError', () => {
    const inner = encodeTlv(0, false, 4, Buffer.from('abc'));
    const ber = Buffer.concat([Buffer.of(0x24, 0x80), inner, inner, Buffer.of(0, 0)]);
    expect(() => readTlv(ber)).toThrow(NotDerError);
    expect(() => readTlv(Buffer.of(0x04, 0x81, 0x03, 1, 2, 3))).toThrow(NotDerError);
    expect(() => readTlv(Buffer.concat([Buffer.of(0x04, 0x82, 0x00, 0x90), Buffer.alloc(0x90)]))).toThrow(NotDerError);
    // Still a DerError, so "the reader throws only DerError" holds.
    expect(() => readTlv(ber)).toThrow(DerError);
    // The shortest long form is read.
    expect(readTlv(Buffer.concat([Buffer.of(0x04, 0x81, 0x90), Buffer.alloc(0x90)])).content.length).toBe(0x90);
  });

  it('derSetOf sorts a SET OF per X.690 §11.6 and is independent of input order', () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 20 }), { maxLength: 6 }), (items) => {
        const els = items.map((b) => encodeTlv(0, false, 4, b));
        const a = derSetOf(els);
        const b = derSetOf([...els].reverse());
        expect(Buffer.compare(a, b)).toBe(0);
        const kids = readAll(readTlv(a).content).map((t) => Buffer.from(t.raw));
        for (let i = 1; i < kids.length; i++) expect(Buffer.compare(kids[i - 1] ?? Buffer.alloc(0), kids[i] ?? Buffer.alloc(0))).toBeLessThanOrEqual(0);
      }),
    );
  });
});

function normalize(n: Node): Node {
  return 'value' in n ? { cls: n.cls, tag: n.tag, value: new Uint8Array(n.value) } : { cls: n.cls, tag: n.tag, kids: n.kids.map(normalize) };
}

describe('OpenPGP packet parser', () => {
  it('round-trips new-format packets of any length', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 63 }), fc.uint8Array({ maxLength: 9000 })), { maxLength: 4 }), (packets) => {
        const bytes = Buffer.concat(packets.map(([t, b]) => encodePacket(t, b)));
        const back = readPackets(bytes);
        expect(back.map((p) => [p.tag, new Uint8Array(p.body)])).toEqual(packets.map(([t, b]) => [t, new Uint8Array(b)]));
      }),
      { numRuns: 200 },
    );
  });

  it('never throws anything but PgpError on random bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        for (const f of [() => readPackets(bytes), () => parseKeys(bytes), () => parseSignaturePacket(Buffer.from(bytes))]) {
          try {
            f();
          } catch (err) {
            expect(err).toBeInstanceOf(PgpError);
          }
        }
      }),
      { numRuns: 3000 },
    );
  });
});

describe('streaming', () => {
  it('the verdict does not depend on chunk boundaries', async () => {
    const eml = fixture('pgp-mime-signed-ed25519.eml');
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: eml.length }), { maxLength: 30 }), async (cuts) => {
        const points = [...new Set(cuts)].sort((a, b) => a - b);
        const chunks: Buffer[] = [];
        let last = 0;
        for (const p of points) {
          chunks.push(eml.subarray(last, p));
          last = p;
        }
        chunks.push(eml.subarray(last));
        const r = await analyzeMessage(chunks, [alice()]);
        expect(r.signature.status).toBe('verified-known-key');
      }),
      { numRuns: 60 },
    );
  });

  // PST-REQ-160: analyzeMessage is total. Every status is one of the binding set.
  const STATUS = /^(verified-known-key|valid-signature-unknown-key|bad-signature|not-signed|unsupported:.+)$/s;
  const DECRYPTION = /^(decrypted|no-key|not-encrypted|failed:.+)$/s;

  it("regression: the verifier's counterexample (edit [[868,47]] on smime-signed.eml) is a status, not a RangeError", async () => {
    const m = Buffer.from(fixture('smime-signed.eml'));
    m[868] = 47;
    const r = await analyzeMessage([m], []);
    expect(r.signature.status).toMatch(STATUS);
    expect(r.signature.status).not.toBe('unsupported:internal-error');
    expect(r.signature.status).toBe('unsupported:malformed-certificate');
  });

  it('regression: a certificate whose public key node:crypto decodes lazily (and fails on) is a status, not a throw', async () => {
    // Found by this property once it also refused 'unsupported:internal-error': X509Certificate
    // parses, then its publicKey getter throws "decode error" at first use.
    for (const [name, at, v] of [['smime-cms-signed.eml', 2254, 47], ['smime-signed.eml', 2285, 69], ['smime-signed.eml', 2264, 45]] as const) {
      const m = Buffer.from(fixture(name));
      m[at] = v;
      const r = await analyzeMessage([m], [alice('own', true), bob('own', true), carol('own', true)]);
      expect(r.signature.status).toMatch(STATUS);
      expect(r.signature.status).not.toBe('unsupported:internal-error');
    }
  });

  for (const name of ['smime-signed.eml', 'smime-cms-signed.eml', 'pgp-mime-signed-ed25519.eml', 'pgp-mime-signed-encrypted.eml', 'smime-encrypted.eml', 'pgp-clearsigned.eml', 'smime-ber-detached.eml', 'smime-ber-opaque.eml', 'smime-ber-encrypted.eml']) {
    it(`arbitrary mutations of ${name} never throw, and never leave the status set`, async () => {
      const eml = fixture(name);
      const keys = [alice('own', true), bob('own', true), carol('own', true)];
      await fc.assert(
        fc.asyncProperty(fc.array(fc.tuple(fc.nat({ max: eml.length - 1 }), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 8 }), async (edits) => {
          const m = Buffer.from(eml);
          for (const [at, v] of edits) m[at] = v;
          const r = await analyzeMessage([m], keys);
          expect(r.signature.status).toMatch(STATUS);
          expect(r.encryption.status).toMatch(DECRYPTION);
          expect(r.signature.status).not.toBe('unsupported:internal-error');
        }),
        { numRuns: 400 },
      );
    });
  }
});
