// fast-check round-trip properties (PST-T-2.1 doneWhen): header values, and whole multipart trees
// built by buildMessage and parsed back under arbitrary chunking. Plus: arbitrary bytes never throw.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildMessage, encodeHeaderValue, formatHeader, parseHeaderBlock, type BodyEncoding, type PartSpec } from '../../src/index.js';
import { parse } from './helpers.js';

describe('header round trip', () => {
  const values = fc.oneof(
    fc.string({ unit: 'grapheme', maxLength: 120 }),
    fc.string({ unit: fc.constantFrom('a', 'b', ' ', '\t', '=', '?', '_', 'é', '😀', '"', '(', ':', '\r', '\n'), maxLength: 200 }),
    fc.string({ unit: 'binary', maxLength: 60 }).map((s) => s.replace(/[\uD800-\uDFFF]/g, 'x')),
    fc.string({ maxLength: 300 }),
  );

  it('encodeHeaderValue → parse header → decode gives back the same string', () => {
    fc.assert(
      fc.property(values, (value) => {
        const block = Buffer.from(`${formatHeader('Subject', value)}\r\n\r\n`, 'utf8');
        const parsed = parseHeaderBlock(block);
        expect(parsed.getDecoded('subject')).toBe(value);
      }),
      { numRuns: 1500 },
    );
  });

  it('folds encoded output so no line exceeds 78 characters', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 400 }), (value) => {
        const encoded = encodeHeaderValue(value, { nameLength: 7 });
        if (encoded.includes('=?')) {
          const lines = `Subject: ${encoded}`.split('\r\n');
          // The first line carries the name and the first encoded-word; every later line fits.
          expect(lines.slice(1).every((l) => l.length <= 78)).toBe(true);
          expect(encoded.split(/\s+/).every((w) => w.length <= 75)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// --- multipart trees ----------------------------------------------------------------------------

type Tree =
  | { kind: 'leaf'; type: string; encoding: BodyEncoding; body: Uint8Array }
  | { kind: 'multipart'; subtype: string; children: Tree[] }
  | { kind: 'message'; subject: string; body: Tree };

const leafArb: fc.Arbitrary<Tree> = fc.oneof(
  fc.record({
    kind: fc.constant('leaf' as const),
    type: fc.constantFrom('application/octet-stream', 'image/png', 'text/plain'),
    encoding: fc.constantFrom<BodyEncoding>('base64', 'quoted-printable'),
    body: fc.uint8Array({ maxLength: 400 }),
  }),
  fc.record({
    kind: fc.constant('leaf' as const),
    type: fc.constantFrom('text/plain', 'text/html'),
    encoding: fc.constantFrom<BodyEncoding>('8bit', 'binary', '7bit'),
    // Raw bodies: any bytes, including CR/LF and lines starting with "--" (they cannot contain the random boundary).
    body: fc
      .array(fc.oneof(fc.constantFrom('\r\n', '\n', '\r', '--', '-', '--x', ' ', 'text', '='), fc.string({ maxLength: 8 })), { maxLength: 40 })
      .map((a) => Buffer.from(a.join(''), 'utf8')),
  }),
);

const treeArb: fc.Arbitrary<Tree> = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leafArb,
    fc.record({
      kind: fc.constant('multipart' as const),
      subtype: fc.constantFrom('mixed', 'alternative', 'related'),
      children: fc.array(tie('tree'), { minLength: 1, maxLength: 3 }),
    }),
    fc.record({ kind: fc.constant('message' as const), subject: fc.string({ unit: 'grapheme', maxLength: 20 }), body: tie('tree') }),
  ),
})).tree;

function depthOf(t: Tree): number {
  if (t.kind === 'leaf') return 0;
  if (t.kind === 'message') return 1 + depthOf(t.body);
  return 1 + Math.max(...t.children.map(depthOf));
}

function toSpec(t: Tree): PartSpec {
  if (t.kind === 'leaf') return { contentType: t.type, encoding: t.encoding, body: t.body };
  if (t.kind === 'multipart') return { kind: 'multipart', subtype: t.subtype, parts: t.children.map(toSpec) };
  return { kind: 'message', message: { headers: [['Subject', t.subject]], body: toSpec(t.body) } };
}

interface Expect {
  id: string;
  contentType: string;
  body: Buffer;
  subject?: string;
}

/** The parts parseMessage should report, in document order. */
function expected(t: Tree, id: string, out: Expect[]): void {
  if (t.kind === 'leaf') {
    out.push({ id, contentType: t.type, body: Buffer.from(t.body) });
  } else if (t.kind === 'multipart') {
    out.push({ id, contentType: `multipart/${t.subtype}`, body: Buffer.alloc(0) });
    t.children.forEach((c, i) => {
      expected(c, `${id}.${String(i + 1)}`, out);
    });
  } else {
    out.push({ id, contentType: 'message/rfc822', body: Buffer.alloc(0) });
    // The encapsulated message and its body part share one header block: Subject + the body's own headers.
    const inner: Expect[] = [];
    expected(t.body, `${id}.1`, inner);
    const first = inner[0];
    if (first !== undefined) first.subject = t.subject;
    out.push(...inner);
  }
}

describe('multipart round trip', () => {
  it('buildMessage → parseMessage under arbitrary chunking gives the same tree and bodies', async () => {
    await fc.assert(
      fc.asyncProperty(
        treeArb.filter((t) => depthOf(t) <= 4),
        fc.string({ unit: 'grapheme', maxLength: 30 }),
        fc.array(fc.nat({ max: 20_000 }), { maxLength: 16 }),
        fc.integer({ min: 1, max: 4096 }),
        async (tree, subject, cuts, slice) => {
          const wire = buildMessage({ headers: [['Subject', subject]], body: toSpec(tree) });
          const want: Expect[] = [];
          expected(tree, '1', want);
          const root = want[0];
          if (root !== undefined) root.subject = subject;
          const parsed = await parse(wire, { cuts, sliceBytes: slice });
          expect(parsed.warnings).toEqual([]);
          expect(parsed.parts.map((p) => [p.part.id, p.part.contentType])).toEqual(want.map((w) => [w.id, w.contentType]));
          parsed.parts.forEach((p, i) => {
            const w = want[i] as Expect;
            expect(p.body.equals(w.body), `body of ${w.id}`).toBe(true);
            expect(p.ended).toBe(true);
            if (w.subject !== undefined) expect(p.part.headers.getDecoded('subject')).toBe(w.subject);
          });
          expect(parsed.stats?.maxRetainedBytes).toBeLessThanOrEqual(parsed.stats?.retainedBound ?? 0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('robustness', () => {
  const mimeish = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom('\r\n', '\n', '\r', '--', '--b', '--b--', ':', ' ', '=', '=?utf-8?B?', '?=', 'Content-Type: multipart/mixed; boundary=b', 'Content-Type: message/rfc822', 'Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: quoted-printable') },
    { weight: 2, arbitrary: fc.string({ maxLength: 20 }) },
    { weight: 1, arbitrary: fc.uint8Array({ maxLength: 40 }).map((b) => Buffer.from(b).toString('latin1')) },
  );

  it('never throws on arbitrary bytes at arbitrary chunking, and always terminates with an end event', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.uint8Array({ maxLength: 2000 }), fc.array(mimeish, { maxLength: 80 }).map((a) => Buffer.from(a.join(''), 'latin1'))),
        fc.array(fc.nat({ max: 3000 }), { maxLength: 10 }),
        async (bytes, cuts) => {
          const parsed = await parse(bytes, { cuts, maxDepth: 8 });
          expect(parsed.events[parsed.events.length - 1]?.type).toBe('end');
          expect(parsed.parts.every((p) => p.ended)).toBe(true);
          expect(parsed.stats?.bytesIn).toBe(bytes.length);
          expect(parsed.stats?.maxRetainedBytes).toBeLessThanOrEqual(parsed.stats?.retainedBound ?? 0);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
