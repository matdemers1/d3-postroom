// RFC 6350 examples and synthetic Apple / Google / Outlook exports (PST-T-8.1 doneWhen).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addressesOf,
  displayName,
  emailsOf,
  getParam,
  getProperties,
  getProperty,
  nameOf,
  parseDataUri,
  parseVCard,
  parseVCards,
  photoOf,
  serializeVCard,
  structuredOf,
  telsOf,
  textOf,
  typesOf,
  utf8Length,
  VCardError,
  VCardLimitError,
  VCardParseError,
  versionOf,
  type VCard,
} from '../../src/index.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const vcfFiles = readdirSync(fixtures).filter((f) => f.endsWith('.vcf'));
const read = (f: string): string => readFileSync(join(fixtures, f), 'utf8');
const cards = (f: string): VCard[] => parseVCards(read(f));
const first = (f: string): VCard => {
  const c = cards(f)[0];
  if (c === undefined) throw new Error(`no card in ${f}`);
  return c;
};

describe('parse and round-trip every fixture', () => {
  it.each(vcfFiles)('%s parses and parse(serialize(parse(x))) deep-equals parse(x)', (f) => {
    const once = cards(f);
    expect(once.length).toBeGreaterThan(0);
    const text = serializeVCard(once);
    expect(parseVCards(text)).toEqual(once);
    expect(serializeVCard(parseVCards(text))).toBe(text);
    for (const line of text.split('\r\n')) expect(utf8Length(line)).toBeLessThanOrEqual(75);
  });
});

describe('RFC 6350 examples', () => {
  const [simon, john, stevenson, group] = cards('rfc6350-examples.vcf');
  it('§8: the full example', () => {
    if (simon === undefined) throw new Error('missing');
    expect(versionOf(simon)).toBe('4.0');
    expect(displayName(simon)).toBe('Simon Perreault');
    expect(nameOf(simon)).toEqual({ family: ['Perreault'], given: ['Simon'], additional: [], prefixes: [], suffixes: ['ing. jr', 'M.Sc.'] });
    expect(addressesOf(simon)[0]).toMatchObject({ types: ['work'], extended: ['Suite D2-630'], street: ['2875 Laurier'], locality: ['Quebec'], region: ['QC'], postalCode: ['G1V 2M2'], country: ['Canada'] });
    expect(telsOf(simon)).toEqual([
      { value: 'tel:+1-418-656-9254;ext=102', types: ['work', 'voice'], pref: 1, label: null },
      { value: 'tel:+1-418-262-6501', types: ['work', 'cell', 'voice', 'video', 'text'], pref: 100, label: null },
    ]);
    expect(emailsOf(simon)).toEqual([{ address: 'simon.perreault@viagenie.ca', types: ['work'], pref: 100, label: null }]);
    expect(getProperty(simon, 'KEY')?.value).toBe('http://www.viagenie.ca/simon.perreault/simon.asc');
    expect(getProperties(simon, 'LANG').map((p) => getParam(p, 'pref'))).toEqual(['1', '2']);
  });
  it('§6.2.2 / §6.3.1: structured N and ADR with a quoted LABEL', () => {
    if (john === undefined || stevenson === undefined) throw new Error('missing');
    expect(displayName(john)).toBe('Mr. John Q. Public, Esq.');
    expect(nameOf(stevenson)).toEqual({ family: ['Stevenson'], given: ['John'], additional: ['Philip', 'Paul'], prefixes: ['Dr.'], suffixes: ['Jr.', 'M.D.', 'A.C.P.'] });
    const adr = addressesOf(john)[0];
    expect(adr?.street).toEqual(['123 Main Street']);
    expect(adr?.label).toBe('Mr. John Q. Public, Esq.\\nMail Drop: TNE QB\\n123 Main Street\\nAny Town, CA  91921-1234\\nU.S.A.');
    expect(emailsOf(john).map((e) => e.address)).toEqual(['jane_doe@example.com', 'jqpublic@xyz.example.com']);
  });
  it('§6.1.4 KIND:group with MEMBERs has no address to harvest', () => {
    if (group === undefined) throw new Error('missing');
    expect(getProperty(group, 'KIND')?.value).toBe('group');
    expect(getProperties(group, 'MEMBER')).toHaveLength(2);
    expect(emailsOf(group)).toEqual([]);
    expect(displayName(group)).toBe('The Doe family');
  });
});

describe('Apple Contacts 3.0 (synthetic)', () => {
  const [alex, plumber] = cards('apple-contacts-3.0.vcf');
  it('groups, X-ABLabel, type=pref and case-insensitive de-duplication', () => {
    if (alex === undefined) throw new Error('missing');
    expect(getProperty(alex, 'EMAIL')?.group).toBe('item1');
    expect(emailsOf(alex)).toEqual([
      { address: 'alex@example.org', types: [], pref: 1, label: 'Other' },
      { address: 'alex.example@work.example.com', types: ['work'], pref: 100, label: null },
      { address: 'tinker@example.net', types: [], pref: 100, label: 'Hobbies' },
    ]);
    expect(telsOf(alex)[0]).toEqual({ value: '+1 (555) 010-0100', types: ['cell', 'voice'], pref: 1, label: null });
    expect(addressesOf(alex)[0]).toMatchObject({ street: ['1 Example Street\nApt 2'], locality: ['Springfield'], pref: 1 });
    expect(textOf(getProperty(alex, 'NOTE') ?? { group: null, name: 'NOTE', params: {}, value: '' })).toBe('Met at the maker fair.\nLikes: soldering, gears; and tea.');
    expect(structuredOf(getProperty(alex, 'ORG') ?? { group: null, name: 'ORG', params: {}, value: '' })).toEqual([['Example Widgets Ltd.'], ['Research']]);
  });
  it('inline base64 PHOTO with ENCODING=b', () => {
    if (alex === undefined) throw new Error('missing');
    const photo = photoOf(alex);
    expect(photo?.kind).toBe('inline');
    if (photo?.kind !== 'inline') return;
    expect(photo.mediaType).toBe('image/jpeg');
    expect([...photo.data.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect([...photo.data.slice(-2)]).toEqual([0xff, 0xd9]);
  });
  it('an empty FN and N fall back to ORG', () => {
    if (plumber === undefined) throw new Error('missing');
    expect(displayName(plumber)).toBe('Example Plumbing Co.');
  });
});

describe('Google Contacts 3.0 (synthetic)', () => {
  const [sam, nameless] = cards('google-contacts-3.0.vcf');
  it('multi-valued EMAIL with TYPE', () => {
    if (sam === undefined) throw new Error('missing');
    expect(emailsOf(sam)).toEqual([
      { address: 'sam@example.net', types: ['home'], pref: 100, label: null },
      { address: 'sam.sample@example.com', types: [], pref: 100, label: null },
    ]);
    expect(textOf(getProperty(sam, 'URL') ?? { group: null, name: 'URL', params: {}, value: '' })).toBe('https\\://sam.example.net');
  });
  it('a card with no name at all is shown by its e-mail address', () => {
    if (nameless === undefined) throw new Error('missing');
    expect(displayName(nameless)).toBe('no-name@example.org');
  });
});

describe('Outlook 2.1 (synthetic)', () => {
  const riley = first('outlook-2.1.vcf');
  it('bare parameters become TYPE values', () => {
    expect(getProperties(riley, 'TEL').map(typesOf)).toEqual([
      ['work', 'voice'],
      ['cell', 'voice'],
    ]);
    expect(emailsOf(riley)).toEqual([
      { address: 'riley@example.com', types: [], pref: 1, label: null },
      { address: 'r.sample@example.org', types: [], pref: 100, label: null },
    ]);
  });
  it('quoted-printable soft line breaks are joined and decoded, with CHARSET', () => {
    const label = getProperty(riley, 'LABEL');
    expect(label && textOf(label)).toBe('100 Example Avenue\r\nMetropolis, XX 00001\r\nExampleland');
    const note = getProperty(riley, 'NOTE');
    expect(note && textOf(note)).toBe('Prefers e-mail. Café meetings on Fridays.');
    expect(displayName(riley)).toBe('Riley Sample');
  });
});

describe('vCard 4.0 data: URI photo and PREF ordering', () => {
  const casey = first('vcard-4.0-data-uri.vcf');
  it('PREF orders e-mail and mailto: is stripped', () => {
    expect(emailsOf(casey).map((e) => [e.address, e.pref])).toEqual([
      ['casey@work.example', 1],
      ['casey@example.org', 2],
      ['casey.alt@example.net', 100],
    ]);
  });
  it('PHOTO data: URI decodes to bytes', () => {
    const photo = photoOf(casey);
    expect(photo?.kind === 'inline' && photo.mediaType).toBe('image/png');
    expect(photo?.kind === 'inline' && [...photo.data.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  });
  it('parseDataUri handles percent-encoded and base64 forms, and rejects junk', () => {
    expect(new TextDecoder().decode(parseDataUri('data:,hello%20world').data)).toBe('hello world');
    expect(parseDataUri('data:;base64,aGk=').mediaType).toBe('text/plain');
    expect(() => parseDataUri('http://example.com')).toThrow(VCardParseError);
    expect(() => parseDataUri('data:image/png;base64,***')).toThrow(VCardParseError);
    expect(() => parseDataUri('data:,%E0%A4%A')).toThrow(VCardParseError);
  });
  it('PHOTO by URI, and an undecodable PHOTO is null rather than a throw', () => {
    const uri = parseVCard('BEGIN:VCARD\r\nVERSION:4.0\r\nPHOTO:https://example.com/p.jpg\r\nEND:VCARD\r\n');
    expect(photoOf(uri)).toEqual({ kind: 'uri', uri: 'https://example.com/p.jpg' });
    const bad = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nPHOTO;ENCODING=b;TYPE=JPEG:!!!\r\nEND:VCARD\r\n');
    expect(photoOf(bad)).toBeNull();
  });
});

describe('errors and limits', () => {
  it('rejects malformed framing with VCardParseError', () => {
    expect(() => parseVCards('BEGIN:VCARD\r\n')).toThrow(/never closed/);
    expect(() => parseVCards('END:VCARD\r\n')).toThrow(/no open/);
    expect(() => parseVCards('FN:x\r\n')).toThrow(/outside/);
    expect(() => parseVCards('BEGIN:VCARD\r\nBEGIN:VCARD\r\nEND:VCARD\r\nEND:VCARD\r\n')).toThrow(/inside/);
    expect(() => parseVCards('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toThrow(VCardParseError);
    expect(() => parseVCard('')).toThrow(VCardParseError);
    expect(() => parseVCard('BEGIN:VCARD\r\nEND:VCARD\r\nBEGIN:VCARD\r\nEND:VCARD\r\n')).toThrow(VCardParseError);
    expect(() => parseVCards('BEGIN:VCARD\r\n.EMAIL:x\r\nEND:VCARD\r\n')).toThrow(VCardParseError);
  });
  it('enforces size, line and card limits with VCardLimitError', () => {
    const one = 'BEGIN:VCARD\r\nFN:x\r\nEND:VCARD\r\n';
    expect(() => parseVCards(one, { maxBytes: 5 })).toThrow(VCardLimitError);
    expect(() => parseVCards(one.repeat(3), { maxCards: 2 })).toThrow(VCardLimitError);
    expect(() => parseVCards(one, { maxLines: 2 })).toThrow(VCardLimitError);
  });
  it('the serializer refuses what it cannot write', () => {
    expect(() => serializeVCard({ properties: [{ group: null, name: 'FN', params: {}, value: 'a\r\nb' }] })).toThrow(VCardError);
    expect(() => serializeVCard({ properties: [{ group: 'a.b', name: 'FN', params: {}, value: 'x' }] })).toThrow(VCardError);
    expect(() => serializeVCard({ properties: [{ group: null, name: 'END', params: {}, value: 'VCARD' }] })).toThrow(VCardError);
  });
  it('a grouped BEGIN is an ordinary property, not framing', () => {
    const c = parseVCard('BEGIN:VCARD\r\nitem1.BEGIN:x\r\nEND:VCARD\r\n');
    expect(c.properties).toEqual([{ group: 'item1', name: 'BEGIN', params: {}, value: 'x' }]);
    expect(parseVCard(serializeVCard(c))).toEqual(c);
  });
});
