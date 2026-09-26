// fast-check properties (PST-T-8.1 doneWhen, PST-REQ-088): round-trip, folding identity, helper
// totality, and nothing but VCardError ever escapes.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  addressesOf,
  displayName,
  emailsOf,
  fold,
  nameOf,
  parseDataUri,
  parseVCards,
  photoOf,
  serializeVCard,
  telsOf,
  unfold,
  utf8Length,
  VCardError,
  type VCard,
} from '../../src/index.js';

const RUNS = Number(process.env.FC_RUNS ?? 300);
vi.setConfig({ testTimeout: 120_000 });

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const fixtureLines = readdirSync(fixtures)
  .filter((f) => f.endsWith('.vcf'))
  .flatMap((f) => readFileSync(join(fixtures, f), 'utf8').split(/\r\n|\n/))
  .filter((l) => l !== '');

function tolerant<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (err) {
    if (err instanceof VCardError) return undefined;
    throw err;
  }
}

const nameArb = fc.stringMatching(/^[A-Z][A-Z0-9-]{0,11}$/);
const groupArb = fc.option(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,7}$/), { nil: null });
const noBreak = (s: string): boolean => !/[\r\n]/.test(s);
const textArb = fc.oneof(
  fc.string({ maxLength: 100 }),
  fc.string({ unit: 'grapheme', maxLength: 50 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom('Doe;John;;;', 'a\\,b\\;c', 'mailto:x@example.com', 'data:image/png;base64,iVBORw0KGgo=', '=C3=A9=', '"q"', '^n'),
);
const propertyArb = fc
  .record({
    group: groupArb,
    name: nameArb,
    params: fc.dictionary(nameArb, fc.array(textArb.filter((s) => !s.includes('\r')), { minLength: 1, maxLength: 3 }), { maxKeys: 3 }),
    value: textArb.filter(noBreak),
  })
  // An ungrouped BEGIN/END is framing, not a property; and a quoted-printable value ending in `=`
  // is a soft line break by definition, so neither can exist inside a parsed card.
  .filter((p) => !(p.group === null && (p.name === 'BEGIN' || p.name === 'END')))
  .filter((p) => !(p.value.endsWith('=') && [...(p.params.ENCODING ?? []), ...(p.params.TYPE ?? [])].some((v) => v.toUpperCase() === 'QUOTED-PRINTABLE')));
const cardArb: fc.Arbitrary<VCard> = fc.record({ properties: fc.array(propertyArb, { maxLength: 8 }) });

const vcfLikeArb = fc
  .array(
    fc.oneof(
      { weight: 5, arbitrary: fc.constantFrom(...fixtureLines) },
      { weight: 2, arbitrary: fc.constantFrom('BEGIN:VCARD', 'END:VCARD', 'item1.EMAIL:a@b', 'NOTE;ENCODING=QUOTED-PRINTABLE:x=', 'TEL;WORK;VOICE:1', ' ', '=', ';', ':', '"') },
      { weight: 1, arbitrary: fc.string({ maxLength: 30 }) },
    ),
    { maxLength: 60 },
  )
  .chain((parts) => fc.array(fc.constantFrom('\r\n', '\n', '\r', '\r\n ', ''), { minLength: parts.length, maxLength: parts.length }).map((seps) => parts.map((p, i) => p + (seps[i] ?? '')).join('')));

describe('round-trip', () => {
  it('parse(serialize(cards)) deep-equals the cards', () => {
    fc.assert(
      fc.property(fc.array(cardArb, { maxLength: 3 }), (cards) => {
        expect(parseVCards(serializeVCard(cards))).toEqual(cards);
      }),
      { numRuns: RUNS },
    );
  });
  it('parse(serialize(parse(x))) deep-equals parse(x) for any x that parses', () => {
    fc.assert(
      fc.property(vcfLikeArb, (x) => {
        const once = tolerant(() => parseVCards(x));
        if (once === undefined) return;
        expect(parseVCards(serializeVCard(once))).toEqual(once);
      }),
      { numRuns: RUNS * 3 },
    );
  });
});

describe('folding', () => {
  it('unfold(fold(line)) is the identity and physical lines stay within 75 octets', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 300 }), fc.string({ unit: 'grapheme', maxLength: 150 })).filter(noBreak), (value) => {
        const line = `NOTE:${value}`;
        const folded = fold(line);
        for (const physical of folded.split('\r\n')) expect(utf8Length(physical)).toBeLessThanOrEqual(75);
        expect(unfold(folded).map((l) => l.text)).toEqual([line]);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('helpers are total and never throw anything but VCardError', () => {
  it('parsing arbitrary input, then every helper on whatever parsed', () => {
    fc.assert(
      fc.property(fc.oneof(vcfLikeArb, fc.string({ maxLength: 300 }), fc.uint8Array({ maxLength: 300 })), (input) => {
        const cards = tolerant(() => parseVCards(input)) ?? [];
        for (const c of cards) {
          const name = displayName(c);
          expect(typeof name).toBe('string');
          for (const e of emailsOf(c)) expect(e.address).toContain('@');
          const emails = emailsOf(c).map((e) => e.address.toLowerCase());
          expect(new Set(emails).size).toBe(emails.length);
          telsOf(c);
          addressesOf(c);
          nameOf(c);
          photoOf(c);
        }
      }),
      { numRuns: RUNS * 3 },
    );
  });
  it('helpers on generated cards', () => {
    fc.assert(
      fc.property(cardArb, (c) => {
        expect(typeof displayName(c)).toBe('string');
        const prefs = emailsOf(c).map((e) => e.pref);
        expect([...prefs].sort((a, b) => a - b)).toEqual(prefs);
        telsOf(c);
        addressesOf(c);
        photoOf(c);
      }),
      { numRuns: RUNS },
    );
  });
  it('parseDataUri', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 80 }), fc.string({ maxLength: 60 }).map((s) => `data:${s}`)), (s) => {
        tolerant(() => parseDataUri(s));
      }),
      { numRuns: RUNS },
    );
  });
});
