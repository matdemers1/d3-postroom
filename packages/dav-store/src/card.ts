// A contact as the webmail edits it, and the vCard it is stored as (PST-REQ-137, PST-REQ-138).
//
// New cards are vCard 3.0 — what iOS Contacts writes and reads best over CardDAV. An edit changes
// only the fields the web form owns (FN, N, EMAIL, TEL, ORG, NOTE) and keeps everything else on
// the card as the phone wrote it — PHOTO, ADR, birthdays, Apple's grouped labels — so editing a
// contact on the web never strips what the iPhone knows about it.
import {
  displayName,
  emailsOf,
  escapeText,
  getProperty,
  nameOf,
  parseVCard,
  serializeVCard,
  structuredOf,
  telsOf,
  textOf,
  type VCard,
  type VCardProperty,
} from '@postroom/vcard';

export interface ContactEmail {
  readonly address: string;
  /** A TYPE such as `work` or `home`, lower-cased, or null. */
  readonly type: string | null;
}

export interface ContactTel {
  readonly value: string;
  readonly type: string | null;
}

export interface ContactFields {
  /** The formatted name (FN). Derived from N, ORG or the first e-mail when blank. */
  readonly fn: string;
  readonly given: string;
  readonly family: string;
  readonly emails: readonly ContactEmail[];
  readonly tels: readonly ContactTel[];
  readonly org: string;
  readonly note: string;
}

export interface ContactView extends ContactFields {
  /** What a list shows: FN, else N, ORG, NICKNAME or the first e-mail. */
  readonly displayName: string;
  /** The card carries a PHOTO (kept on edit; not editable from the web). */
  readonly hasPhoto: boolean;
}

const OWNED = new Set(['FN', 'N', 'EMAIL', 'TEL', 'ORG', 'NOTE', 'REV']);

const TYPE_WORDS = new Set(['internet', 'pref', 'voice', 'x400']);

function firstType(types: readonly string[]): string | null {
  return types.find((t) => !TYPE_WORDS.has(t)) ?? null;
}

/** `20260926T101500Z` — the REV stamp (RFC 6350 §6.7.4). */
export function revStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The editable fields of a stored card. */
export function contactOf(card: VCard): ContactView {
  const n = nameOf(card);
  const fn = getProperty(card, 'FN');
  const org = getProperty(card, 'ORG');
  const note = getProperty(card, 'NOTE');
  return {
    fn: fn === undefined ? '' : textOf(fn).trim(),
    given: n?.given.join(' ') ?? '',
    family: n?.family.join(' ') ?? '',
    emails: emailsOf(card).map((e) => ({ address: e.address, type: firstType(e.types) })),
    tels: telsOf(card).map((t) => ({ value: t.value, type: firstType(t.types) })),
    org: org === undefined ? '' : (structuredOf(org)[0]?.join(', ') ?? '').trim(),
    note: note === undefined ? '' : textOf(note),
    displayName: displayName(card),
    hasPhoto: getProperty(card, 'PHOTO') !== undefined,
  };
}

/** The editable fields of a stored card's bytes (one vCard). */
export function contactOfBytes(data: Uint8Array): ContactView {
  return contactOf(parseVCard(data, { maxCards: 1 }));
}

function formattedName(fields: ContactFields): string {
  const fn = fields.fn.trim();
  if (fn !== '') return fn;
  const n = [fields.given.trim(), fields.family.trim()].filter((x) => x !== '').join(' ');
  if (n !== '') return n;
  if (fields.org.trim() !== '') return fields.org.trim();
  return fields.emails[0]?.address.trim() ?? '';
}

function prop(name: string, value: string, params: Record<string, string[]> = {}): VCardProperty {
  return { group: null, name, params, value };
}

/** The properties the web form owns, in the conventional order. */
function ownedProperties(fields: ContactFields, now: Date): VCardProperty[] {
  const out: VCardProperty[] = [
    prop('FN', escapeText(formattedName(fields))),
    prop('N', [fields.family, fields.given, '', '', ''].map((x) => escapeText(x.trim())).join(';')),
  ];
  if (fields.org.trim() !== '') out.push(prop('ORG', escapeText(fields.org.trim())));
  fields.emails.forEach((e, i) => {
    const address = e.address.trim();
    if (address === '') return;
    const types = ['INTERNET', ...(e.type === null || e.type.trim() === '' ? [] : [e.type.trim().toUpperCase()]), ...(i === 0 ? ['pref'] : [])];
    out.push(prop('EMAIL', escapeText(address), { TYPE: types }));
  });
  for (const t of fields.tels) {
    const value = t.value.trim();
    if (value === '') continue;
    out.push(prop('TEL', escapeText(value), t.type === null || t.type.trim() === '' ? {} : { TYPE: [t.type.trim().toUpperCase()] }));
  }
  if (fields.note.trim() !== '') out.push(prop('NOTE', escapeText(fields.note)));
  out.push(prop('REV', revStamp(now)));
  return out;
}

/** A new vCard 3.0 for these fields. */
export function buildContactCard(uid: string, fields: ContactFields, now: Date): VCard {
  return {
    properties: [prop('VERSION', '3.0'), prop('PRODID', '-//Postroom//Webmail//EN'), prop('UID', escapeText(uid)), ...ownedProperties(fields, now)],
  };
}

/** A new card's bytes, as stored. */
export function contactCardBytes(uid: string, fields: ContactFields, now: Date): Buffer {
  return Buffer.from(serializeVCard(buildContactCard(uid, fields, now)), 'utf8');
}

/**
 * `card` with the form's fields replaced and everything else kept. A grouped label
 * (`item1.X-ABLabel`) whose only property was a removed EMAIL or TEL goes with it.
 */
export function applyContactFields(card: VCard, fields: ContactFields, now: Date): VCard {
  const removedGroups = new Set<string>();
  for (const p of card.properties) if (OWNED.has(p.name) && p.group !== null) removedGroups.add(p.group.toLowerCase());
  for (const p of card.properties) if (!OWNED.has(p.name) && p.name !== 'X-ABLABEL' && p.group !== null) removedGroups.delete(p.group.toLowerCase());
  const kept = card.properties.filter((p) => {
    if (OWNED.has(p.name)) return false;
    if (p.name === 'X-ABLABEL' && p.group !== null && removedGroups.has(p.group.toLowerCase())) return false;
    return true;
  });
  const at = kept.findIndex((p) => p.name !== 'VERSION' && p.name !== 'PRODID' && p.name !== 'UID');
  const owned = ownedProperties(fields, now);
  const properties = at < 0 ? [...kept, ...owned] : [...kept.slice(0, at), ...owned, ...kept.slice(at)];
  return { properties };
}
