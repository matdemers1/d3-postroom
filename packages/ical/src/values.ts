// Typed property values (RFC 5545 §3.3): DATE, DATE-TIME (floating, UTC, TZID), DURATION, PERIOD,
// UTC-OFFSET, TEXT and TEXT lists, CAL-ADDRESS. Every parser throws only ICalParseError.
import { daysInMonth } from './civil.js';
import { ICalParseError } from './errors.js';
import { escapeText, splitUnescaped, unescapeText } from './lexer.js';
import type { Property } from './component.js';

export interface ICalDate {
  type: 'date';
  year: number;
  month: number;
  day: number;
}

export interface ICalDateTime {
  type: 'date-time';
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** A trailing `Z`: the value is UTC. */
  utc: boolean;
  /** The TZID parameter, or null. `utc === false && tzid === null` is a floating time. */
  tzid: string | null;
}

export type ICalDateValue = ICalDate | ICalDateTime;

export interface ICalDuration {
  sign: 1 | -1;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export interface ICalPeriod {
  start: ICalDateTime;
  /** Explicit end, or null when the period is given as start/duration. */
  end: ICalDateTime | null;
  duration: ICalDuration | null;
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

function checkDate(y: number, m: number, d: number, raw: string): void {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new ICalParseError(`invalid date "${raw.slice(0, 40)}"`);
}

export function parseDate(s: string): ICalDate {
  const m = DATE_RE.exec(s.trim());
  if (m === null) throw new ICalParseError(`invalid DATE "${s.slice(0, 40)}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  checkDate(year, month, day, s);
  return { type: 'date', year, month, day };
}

export function parseDateTime(s: string, tzid: string | null = null): ICalDateTime {
  const m = DATE_TIME_RE.exec(s.trim());
  if (m === null) throw new ICalParseError(`invalid DATE-TIME "${s.slice(0, 40)}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  checkDate(year, month, day, s);
  // Second 60 is a leap second (§3.3.12); it is accepted and treated as :59 + 1 s on expansion.
  if (hour > 23 || minute > 59 || second > 60) throw new ICalParseError(`invalid time in "${s.slice(0, 40)}"`);
  const utc = m[7] === 'Z';
  return { type: 'date-time', year, month, day, hour, minute, second, utc, tzid: utc ? null : tzid };
}

/** A DATE or DATE-TIME, deciding by `VALUE=DATE` or by shape. */
export function parseDateOrDateTime(s: string, tzid: string | null = null, valueType?: string): ICalDateValue {
  const vt = valueType?.toUpperCase();
  if (vt === 'DATE' || (vt === undefined && DATE_RE.test(s.trim()))) return parseDate(s);
  return parseDateTime(s, tzid);
}

/** The DATE/DATE-TIME value of a property such as DTSTART, honouring VALUE and TZID. */
export function propertyDate(prop: Property): ICalDateValue {
  return parseDateOrDateTime(prop.value, prop.params.TZID?.[0] ?? null, prop.params.VALUE?.[0]);
}

/** A comma-separated list of DATE / DATE-TIME / PERIOD values (RDATE, EXDATE). */
export function propertyDateList(prop: Property): (ICalDateValue | ICalPeriod)[] {
  const tzid = prop.params.TZID?.[0] ?? null;
  const vt = prop.params.VALUE?.[0]?.toUpperCase();
  return prop.value
    .split(',')
    .filter((v) => v.trim() !== '')
    .map((v) => (vt === 'PERIOD' || (vt === undefined && v.includes('/')) ? parsePeriod(v, tzid) : parseDateOrDateTime(v, tzid, vt)));
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function formatDate(d: { year: number; month: number; day: number }): string {
  return `${pad(d.year, 4)}${pad(d.month)}${pad(d.day)}`;
}

export function formatDateTime(d: Omit<ICalDateTime, 'type' | 'tzid'>): string {
  return `${formatDate(d)}T${pad(d.hour)}${pad(d.minute)}${pad(d.second)}${d.utc ? 'Z' : ''}`;
}

export function formatDateValue(v: ICalDateValue): string {
  return v.type === 'date' ? formatDate(v) : formatDateTime(v);
}

const DURATION_RE = /^([+-])?P(?:(\d{1,9})W)?(?:(\d{1,9})D)?(?:T(?:(\d{1,9})H)?(?:(\d{1,9})M)?(?:(\d{1,9})S)?)?$/;

/** DURATION (§3.3.6). Weeks may be combined with other units (RFC 5545 errata / 5545bis). */
export function parseDuration(s: string): ICalDuration {
  const t = s.trim();
  const m = DURATION_RE.exec(t);
  if (m === null || t.endsWith('P') || t.endsWith('T')) throw new ICalParseError(`invalid DURATION "${s.slice(0, 40)}"`);
  return {
    sign: m[1] === '-' ? -1 : 1,
    weeks: Number(m[2] ?? 0),
    days: Number(m[3] ?? 0),
    hours: Number(m[4] ?? 0),
    minutes: Number(m[5] ?? 0),
    seconds: Number(m[6] ?? 0),
  };
}

export function formatDuration(d: ICalDuration): string {
  let out = d.sign < 0 ? '-P' : 'P';
  if (d.weeks) out += `${String(d.weeks)}W`;
  if (d.days) out += `${String(d.days)}D`;
  if (d.hours || d.minutes || d.seconds) {
    out += 'T';
    if (d.hours) out += `${String(d.hours)}H`;
    if (d.minutes) out += `${String(d.minutes)}M`;
    if (d.seconds) out += `${String(d.seconds)}S`;
  }
  return out === 'P' || out === '-P' ? 'PT0S' : out;
}

/** Nominal days (weeks×7 + days) and exact seconds (h/m/s), both signed. */
export function durationParts(d: ICalDuration): { days: number; seconds: number } {
  return { days: d.sign * (d.weeks * 7 + d.days), seconds: d.sign * (d.hours * 3600 + d.minutes * 60 + d.seconds) };
}

/** A DURATION as seconds, treating a day as 86 400 s. */
export function durationToSeconds(d: ICalDuration): number {
  const { days, seconds } = durationParts(d);
  return days * 86_400 + seconds;
}

/** PERIOD (§3.3.9): `start/end` or `start/duration`. */
export function parsePeriod(s: string, tzid: string | null = null): ICalPeriod {
  const slash = s.indexOf('/');
  if (slash < 0) throw new ICalParseError(`invalid PERIOD "${s.slice(0, 40)}"`);
  const start = parseDateTime(s.slice(0, slash), tzid);
  const rest = s.slice(slash + 1).trim();
  if (/^[+-]?P/.test(rest)) return { start, end: null, duration: parseDuration(rest) };
  return { start, end: parseDateTime(rest, tzid), duration: null };
}

export function formatPeriod(p: ICalPeriod): string {
  const tail = p.end !== null ? formatDateTime(p.end) : formatDuration(p.duration ?? { sign: 1, weeks: 0, days: 0, hours: 0, minutes: 0, seconds: 0 });
  return `${formatDateTime(p.start)}/${tail}`;
}

/** UTC-OFFSET (§3.3.14) in seconds east of UTC. */
export function parseUtcOffset(s: string): number {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(s.trim());
  if (m === null) throw new ICalParseError(`invalid UTC-OFFSET "${s.slice(0, 40)}"`);
  const h = Number(m[2]);
  const min = Number(m[3]);
  const sec = Number(m[4] ?? 0);
  if (h > 23 || min > 59 || sec > 59) throw new ICalParseError(`invalid UTC-OFFSET "${s.slice(0, 40)}"`);
  const total = h * 3600 + min * 60 + sec;
  return m[1] === '-' ? -total : total;
}

export function formatUtcOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const a = Math.abs(seconds);
  const s = a % 60;
  return `${sign}${pad(Math.floor(a / 3600))}${pad(Math.floor((a % 3600) / 60))}${s ? pad(s) : ''}`;
}

/** TEXT value (§3.3.11), unescaped. */
export function parseText(raw: string): string {
  return unescapeText(raw);
}

/** A comma-separated TEXT list (CATEGORIES, RESOURCES), each item unescaped. */
export function parseTextList(raw: string): string[] {
  return splitUnescaped(raw, ',').map(unescapeText);
}

export function formatText(s: string): string {
  return escapeText(s);
}

export function formatTextList(items: string[]): string {
  return items.map(escapeText).join(',');
}

const ATEXT_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\-\u0080-\u{10FFFF}]+$/u;
const LDH_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// An IDN U-label (RFC 5890): letters, marks and digits from any script, and hyphens, never
// starting or ending with one. ASCII punctuation other than `-` is never part of a label.
const IDN_LABEL = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u;

/**
 * True when `addr` is exactly one RFC 5321 mailbox, `local@domain`: a dot-atom local part (UTF-8
 * allowed, RFC 6531) of at most 64 octets, and a domain of LDH or IDN labels. Anything carrying a
 * control character (CR/LF above all — header and SMTP command injection), whitespace, `<`, `>`,
 * `,`, `;`, a quoted local part, an address literal, or a second `@` is not a mailbox.
 */
export function isMailbox(addr: string): boolean {
  if (addr.length === 0 || addr.length > 254) return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s<>,;"()[\]\\:]/u.test(addr)) return false;
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@')) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (new TextEncoder().encode(local).length > 64) return false;
  if (!local.split('.').every((atom) => ATEXT_ATOM.test(atom))) return false;
  const bare = domain.endsWith('.') ? domain.slice(0, -1) : domain;
  if (bare.length === 0 || bare.length > 253) return false;
  return bare.split('.').every((label) => LDH_LABEL.test(label) || (/[\u0080-\u{10FFFF}]/u.test(label) && IDN_LABEL.test(label)));
}

/**
 * CAL-ADDRESS (§3.3.3): the e-mail address of a `mailto:` URI, scheme stripped and percent-decoded,
 * or null when the value is not a `mailto:` URI or does not decode to exactly one valid mailbox
 * (`isMailbox`). Never throws: an ORGANIZER or ATTENDEE whose address fails is simply not
 * addressable — a reply is never sent to it and it never reaches a message header.
 */
export function calAddressEmail(raw: string): string | null {
  const v = raw.trim();
  if (!/^mailto:/i.test(v)) return null;
  let addr = v.slice(7);
  try {
    addr = decodeURIComponent(addr);
  } catch {
    // A malformed percent-escape: not a URI anyone can reply to.
    return null;
  }
  return isMailbox(addr) ? addr : null;
}
