// fast-check properties (PST-REQ-088 for the DAV parser): serialize → parse is the identity on any
// tree; arbitrary input only ever throws XmlError; escaped text survives exactly (CRs included);
// hrefs round-trip; precondition evaluation agrees with its definition.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  DavError,
  decodePath,
  encodeSegment,
  evaluatePreconditions,
  parseReport,
  parseXml,
  serializeXml,
  textMatches,
  XmlError,
  type Collation,
  type MatchType,
  type XmlElement,
  type XmlNode,
} from '../../src/index.js';

const RUNS = Number(process.env.FC_RUNS ?? 300);
vi.setConfig({ testTimeout: 120_000 });

const local = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_.-]{0,11}$/);
const nsArb = fc.constantFrom('', 'DAV:', 'urn:ietf:params:xml:ns:caldav', 'http://apple.com/ns/ical/', 'urn:x-odd:"&<>', 'http://example.com/a b');
// Any string XML can carry: no C0 controls but tab/LF/CR, no U+FFFE/FFFF, no lone surrogates.
const xmlText = fc
  .string({ unit: fc.oneof(fc.constantFrom('\t', '\n', '\r', '&', '<', '>', ']]>', '"', "'", ' ', 'é', '😀'), fc.string({ unit: 'grapheme-ascii', maxLength: 1 })), maxLength: 30 })
  .filter((s) => s !== '');
const attrArb = fc.record({ ns: fc.constantFrom('', 'urn:attr'), local, value: fc.oneof(xmlText, fc.constant('')) });

const treeArb: fc.Arbitrary<XmlElement> = fc.letrec<{ el: XmlElement; node: XmlNode }>((tie) => ({
  el: fc.record({
    ns: nsArb,
    local,
    attrs: fc.uniqueArray(attrArb, { maxLength: 3, selector: (a) => `${a.ns} ${a.local}` }),
    children: fc.array(tie('node'), { maxLength: 4, depthIdentifier: 'tree' }).map(mergeText),
  }),
  node: fc.oneof({ depthSize: 'small', withCrossShrink: true }, xmlText, tie('el')),
})).el;

/** The parser merges adjacent text, so the model must too. */
function mergeText(nodes: XmlNode[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (typeof n === 'string' && typeof last === 'string') out[out.length - 1] = last + n;
    else out.push(n);
  }
  return out;
}

describe('XML properties', () => {
  it('parse(serialize(tree)) is the tree', () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        expect(parseXml(serializeXml(tree))).toEqual(tree);
      }),
      { numRuns: RUNS },
    );
  });

  it('arbitrary input throws nothing but XmlError', () => {
    const shaped = fc
      .array(fc.oneof(fc.constantFrom('<', '>', '</', '/>', '<?xml version="1.0"?>', '<!DOCTYPE', '<!ENTITY', '<![CDATA[', ']]>', '<!--', '-->', '&', '&#', '&#x', ';', 'xmlns', 'xmlns:d', '="DAV:"', ':', '"', "'", ' ', 'd:prop', 'a', '\uD800', '\r'), fc.string({ maxLength: 5 })), { maxLength: 60 })
      .map((p) => p.join(''));
    fc.assert(
      fc.property(fc.oneof(shaped, fc.string({ unit: 'binary', maxLength: 200 }), fc.uint8Array({ maxLength: 200 })), (input) => {
        try {
          const root = parseXml(input, { maxDepth: 16 });
          serializeXml(root);
          try {
            parseReport(root);
          } catch (err) {
            if (!(err instanceof DavError)) throw err;
          }
        } catch (err) {
          if (!(err instanceof XmlError)) throw err;
        }
      }),
      { numRuns: RUNS * 3 },
    );
  });

  it('any carried text survives serialization exactly', () => {
    fc.assert(
      fc.property(xmlText, (text) => {
        expect(parseXml(serializeXml({ ns: 'DAV:', local: 't', attrs: [{ ns: '', local: 'v', value: text }], children: [text] }))).toEqual({
          ns: 'DAV:',
          local: 't',
          attrs: [{ ns: '', local: 'v', value: text }],
          children: [text],
        });
      }),
      { numRuns: RUNS },
    );
  });
});

describe('HTTP helper properties', () => {
  it('decodePath(hrefOf(segments)) gives the segments back', () => {
    // eslint-disable-next-line no-control-regex
    const seg = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }).filter((s) => !/[\u0000-\u001f\u007f/\\]/.test(s) && s !== '.' && s !== '..');
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 5 }), (segments) => {
        expect(decodePath(`/${segments.map(encodeSegment).join('/')}/`).segments).toEqual(segments);
      }),
      { numRuns: RUNS },
    );
  });

  it('If-Match lets a write through exactly when the current tag is listed strongly', () => {
    const tag = fc.stringMatching(/^[a-z0-9]{1,6}$/);
    fc.assert(
      fc.property(fc.option(tag, { nil: null }), fc.array(fc.tuple(fc.boolean(), tag), { minLength: 1, maxLength: 4 }), (current, list) => {
        const header = list.map(([weak, t]) => `${weak ? 'W/' : ''}"${t}"`).join(', ');
        const expected = current !== null && list.some(([weak, t]) => !weak && t === current);
        expect(evaluatePreconditions({ ifMatch: header }, current, 'PUT') === null).toBe(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it('negate-condition inverts every match', () => {
    const coll = fc.constantFrom<Collation>('i;octet', 'i;ascii-casemap', 'i;unicode-casemap');
    const mt = fc.constantFrom<MatchType>('equals', 'contains', 'starts-with', 'ends-with');
    fc.assert(
      fc.property(fc.string(), fc.string({ maxLength: 4 }), coll, mt, (value, needle, collation, matchType) => {
        const tm = { value: needle, collation, matchType, negate: false };
        expect(textMatches(value, { ...tm, negate: true })).toBe(!textMatches(value, tm));
      }),
      { numRuns: RUNS },
    );
  });
});
