// vCard objects (RFC 6350 v4, tolerant of v3 RFC 2426 and v2.1): BEGIN:VCARD/END:VCARD framing,
// grouped properties (`item1.EMAIL`), v2.1 bare TYPE parameters and quoted-printable soft line
// breaks, with bounded input, and a serializer whose output re-parses to a deep-equal card.
import { VCardLimitError, VCardParseError } from './errors.js';
import { decodeInput, fold, formatContentLine, parseContentLine, unfold, type Params } from './lexer.js';

export interface VCardProperty {
  /** Group prefix as written (`item1` in `item1.EMAIL`), or null. Compare case-insensitively. */
  group: string | null;
  /** Upper-cased name, e.g. `EMAIL`. */
  name: string;
  params: Params;
  /** Raw value as it appeared on the wire (after unfolding); decode with the value helpers. */
  value: string;
}

export interface VCard {
  /** Every property between BEGIN:VCARD and END:VCARD, in order (VERSION included). */
  properties: VCardProperty[];
}

export interface ParseOptions {
  /** Maximum input size in bytes (UTF-8). Default 8 MiB (inline photos are large). */
  maxBytes?: number;
  /** Maximum number of content lines. Default 200 000. */
  maxLines?: number;
  /** Maximum number of cards. Default 50 000. */
  maxCards?: number;
}

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_LINES = 200_000;
export const DEFAULT_MAX_CARDS = 50_000;

/** vCard 2.1: `ENCODING=QUOTED-PRINTABLE`, or the bare `;QUOTED-PRINTABLE` parameter (parsed as TYPE). */
export function isQuotedPrintable(params: Params): boolean {
  const has = (vs: string[] | undefined): boolean => vs?.some((v) => v.toUpperCase() === 'QUOTED-PRINTABLE') ?? false;
  return has(params.ENCODING) || has(params.TYPE);
}

/** Parse every vCard in the input (a .vcf file often holds many). */
export function parseVCards(input: string | Uint8Array, options: ParseOptions = {}): VCard[] {
  const text = decodeInput(input, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const lines = unfold(text, options.maxLines ?? DEFAULT_MAX_LINES);
  const maxCards = options.maxCards ?? DEFAULT_MAX_CARDS;
  const cards: VCard[] = [];
  let open: VCard | null = null;
  for (let i = 0; i < lines.length; i++) {
    const { text: raw, line } = lines[i] ?? { text: '', line: 0 };
    const cl = parseContentLine(raw, line, { groups: true, bareParamsAreTypes: true });
    // vCard 2.1 quoted-printable soft line breaks: a trailing `=` continues onto the next line with
    // no leading space. The `=` is removed; the value stays quoted-printable encoded.
    if (isQuotedPrintable(cl.params)) {
      while (cl.value.endsWith('=') && i + 1 < lines.length) {
        i++;
        cl.value = cl.value.slice(0, -1) + (lines[i]?.text ?? '');
      }
    }
    if (cl.name === 'BEGIN' && cl.group === null) {
      if (cl.value.trim().toUpperCase() !== 'VCARD') throw new VCardParseError(`BEGIN:${cl.value.slice(0, 20)} is not a vCard`, line);
      if (open !== null) throw new VCardParseError('BEGIN:VCARD inside a vCard', line);
      if (cards.length >= maxCards) throw new VCardLimitError(`more than ${String(maxCards)} vCards`);
      open = { properties: [] };
      cards.push(open);
    } else if (cl.name === 'END' && cl.group === null) {
      if (cl.value.trim().toUpperCase() !== 'VCARD') throw new VCardParseError(`END:${cl.value.slice(0, 20)} is not a vCard`, line);
      if (open === null) throw new VCardParseError('END:VCARD with no open vCard', line);
      open = null;
    } else {
      if (open === null) throw new VCardParseError(`property ${cl.name} outside a vCard`, line);
      open.properties.push({ group: cl.group, name: cl.name, params: cl.params, value: cl.value });
    }
  }
  if (open !== null) throw new VCardParseError('BEGIN:VCARD is never closed');
  return cards;
}

/** Parse input that must hold exactly one vCard (a CardDAV address object resource). */
export function parseVCard(input: string | Uint8Array, options: ParseOptions = {}): VCard {
  const cards = parseVCards(input, options);
  const [first] = cards;
  if (first === undefined) throw new VCardParseError('no vCard in input');
  if (cards.length > 1) throw new VCardParseError(`expected one vCard, found ${String(cards.length)}`);
  return first;
}

/** Serialise with CRLF line endings, folded at 75 octets, ending in CRLF. */
export function serializeVCard(input: VCard | VCard[]): string {
  const out: string[] = [];
  for (const card of Array.isArray(input) ? input : [input]) {
    out.push('BEGIN:VCARD');
    for (const p of card.properties) {
      if (!/^[A-Za-z0-9-]+$/.test(p.name) || (p.group === null && /^(BEGIN|END)$/i.test(p.name))) {
        throw new VCardParseError(`invalid property name "${p.name.slice(0, 40)}"`);
      }
      if (p.group !== null && !/^[A-Za-z0-9-]+$/.test(p.group)) throw new VCardParseError(`invalid group "${p.group.slice(0, 40)}"`);
      for (const pname of Object.keys(p.params)) {
        if (!/^[A-Za-z0-9-]+$/.test(pname)) throw new VCardParseError(`invalid parameter name "${pname.slice(0, 40)}"`);
      }
      out.push(fold(formatContentLine(p, p.group)));
    }
    out.push('END:VCARD');
  }
  return out.map((l) => `${l}\r\n`).join('');
}

/** VERSION of the card (`4.0`, `3.0`, `2.1`), or null if absent. */
export function versionOf(card: VCard): string | null {
  return card.properties.find((p) => p.name === 'VERSION')?.value.trim() ?? null;
}

/** First property with this name (any group), or undefined. */
export function getProperty(card: VCard, name: string): VCardProperty | undefined {
  const upper = name.toUpperCase();
  return card.properties.find((p) => p.name === upper);
}

/** Every property with this name, in document order. */
export function getProperties(card: VCard, name: string): VCardProperty[] {
  const upper = name.toUpperCase();
  return card.properties.filter((p) => p.name === upper);
}

/** First value of a parameter, or undefined. */
export function getParam(prop: VCardProperty, name: string): string | undefined {
  return prop.params[name.toUpperCase()]?.[0];
}
