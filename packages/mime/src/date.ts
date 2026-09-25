// RFC 5322 §3.3 date-time, with the obsolete forms of §4.3: two- and three-digit years, named
// zones (UT, GMT, EST…), military zones, comments, missing seconds, and missing day-of-week.
// Returns null for anything that is not a real instant — never `Invalid Date`.

import { stripComments } from './params.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ZONES: Readonly<Record<string, number>> = {
  ut: 0,
  utc: 0,
  gmt: 0,
  z: 0,
  edt: -4 * 60,
  est: -5 * 60,
  cdt: -5 * 60,
  cst: -6 * 60,
  mdt: -6 * 60,
  mst: -7 * 60,
  pdt: -7 * 60,
  pst: -8 * 60,
};

function zoneOffset(zone: string | undefined): number | null {
  if (zone === undefined || zone === '') return 0; // missing zone: treat as UTC
  const numeric = /^([+-])(\d{2})(\d{2})$/.exec(zone);
  if (numeric !== null) {
    const hours = Number(numeric[2]);
    const minutes = Number(numeric[3]);
    if (minutes > 59) return null;
    return (numeric[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  const named = ZONES[zone.toLowerCase()];
  if (named !== undefined) return named;
  // Military zones (§4.3): their sign was defined backwards in RFC 822, so they mean "unknown" → -0000.
  if (/^[a-ik-z]$/i.test(zone)) return 0;
  return null;
}

/** Parse an RFC 5322 date-time. */
export function parseDate(value: string): Date | null {
  const text = stripComments(value).replace(/\s+/g, ' ').trim();
  const m =
    /^(?:[A-Za-z]{3,}\s*,?\s*)?(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([+-]\d{4}|[A-Za-z]{1,5})?$/.exec(
      text,
    );
  if (m === null) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf((m[2] as string).slice(0, 3).toLowerCase());
  let year = Number(m[3]);
  const yearDigits = (m[3] as string).length;
  if (yearDigits === 2) year += year < 50 ? 2000 : 1900;
  else if (yearDigits === 3) year += 1900;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const offset = zoneOffset(m[7]);
  if (month < 0 || offset === null) return null;
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const ms = Date.UTC(year, month, day, hour, minute, second === 60 ? 59 : second) - offset * 60_000;
  const check = new Date(Date.UTC(year, month, day));
  if (check.getUTCDate() !== day) return null; // 31 Feb and friends
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}
