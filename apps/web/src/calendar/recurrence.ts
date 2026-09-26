// The event form's "Repeat" controls ↔ the API's recurrence and the RRULE it is stored as
// (PST-REQ-136). Pure, so the round trip is unit-tested; the browser behaviour is e2e.
import type { EventDetail, Frequency, RecurrenceInput, Weekday } from '../api';

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const WEEKDAY_NAMES: Readonly<Record<Weekday, { short: string; long: string }>> = {
  MO: { short: 'Mon', long: 'Monday' },
  TU: { short: 'Tue', long: 'Tuesday' },
  WE: { short: 'Wed', long: 'Wednesday' },
  TH: { short: 'Thu', long: 'Thursday' },
  FR: { short: 'Fri', long: 'Friday' },
  SA: { short: 'Sat', long: 'Saturday' },
  SU: { short: 'Sun', long: 'Sunday' },
};

export type RepeatKind = 'none' | Frequency;
export type EndKind = 'never' | 'count' | 'until';

export interface RecurrenceForm {
  repeat: RepeatKind;
  interval: number;
  /** Weekly only. */
  byDay: Weekday[];
  end: EndKind;
  count: number;
  /** `YYYY-MM-DD`. */
  until: string;
}

const FREQS: readonly Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** The weekday of a `YYYY-MM-DD` day. */
export function weekdayOf(day: string): Weekday {
  const [y, m, d] = day.split('-').map(Number);
  const js = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7] ?? 'MO';
}

/** A fresh form for an event starting on `startDay`. */
export function defaultRecurrenceForm(startDay: string): RecurrenceForm {
  return { repeat: 'none', interval: 1, byDay: [weekdayOf(startDay)], end: 'never', count: 10, until: startDay };
}

const sortDays = (days: readonly Weekday[]): Weekday[] => [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));

/** What the API is sent. null: does not repeat. */
export function formToRecurrence(f: RecurrenceForm): RecurrenceInput | null {
  if (f.repeat === 'none') return null;
  const interval = Number.isInteger(f.interval) && f.interval >= 1 ? Math.min(f.interval, 999) : 1;
  return {
    freq: f.repeat,
    interval,
    byDay: f.repeat === 'WEEKLY' ? sortDays(f.byDay) : [],
    count: f.end === 'count' ? Math.max(1, Math.min(5000, Math.trunc(f.count))) : null,
    until: f.end === 'until' ? f.until : null,
  };
}

/** The RRULE the server stores for this form (for an all-day event; timed UNTILs are stored in UTC). */
export function formToRrule(f: RecurrenceForm): string | null {
  const r = formToRecurrence(f);
  if (r === null) return null;
  const parts = [`FREQ=${r.freq}`];
  if (r.until !== null) parts.push(`UNTIL=${r.until.replace(/-/g, '')}`);
  if (r.count !== null) parts.push(`COUNT=${String(r.count)}`);
  if (r.interval !== 1) parts.push(`INTERVAL=${String(r.interval)}`);
  if (r.byDay.length > 0) parts.push(`BYDAY=${r.byDay.join(',')}`);
  return parts.join(';');
}

/**
 * The form for an RRULE, or null when the rule uses parts the form cannot show (BYSETPOS,
 * BYMONTHDAY, `-1FR`, …) — then the form leaves the rule alone.
 */
export function rruleToForm(rule: string, startDay: string): RecurrenceForm | null {
  const f = defaultRecurrenceForm(startDay);
  let freq: Frequency | null = null;
  for (const part of rule.split(';')) {
    const [k = '', v = ''] = part.split('=');
    switch (k.toUpperCase()) {
      case 'FREQ':
        if (!(FREQS as readonly string[]).includes(v.toUpperCase())) return null;
        freq = v.toUpperCase() as Frequency;
        break;
      case 'INTERVAL':
        if (!/^\d+$/.test(v)) return null;
        f.interval = Number(v);
        break;
      case 'COUNT':
        if (!/^\d+$/.test(v)) return null;
        f.end = 'count';
        f.count = Number(v);
        break;
      case 'UNTIL': {
        const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
        if (m === null) return null;
        f.end = 'until';
        f.until = `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}`;
        break;
      }
      case 'BYDAY': {
        const days = v.toUpperCase().split(',');
        if (!days.every((d) => (WEEKDAYS as readonly string[]).includes(d))) return null;
        f.byDay = sortDays(days as Weekday[]);
        break;
      }
      case 'WKST':
        break;
      default:
        return null;
    }
  }
  if (freq === null) return null;
  if (freq !== 'WEEKLY' && rule.toUpperCase().includes('BYDAY=')) return null;
  f.repeat = freq;
  return f;
}

/** The form for an event as the API returned it (UNTIL already a day in the event's zone). */
export function detailToForm(detail: EventDetail, startDay: string): RecurrenceForm | null {
  const r = detail.recurrence;
  if (r === null) return defaultRecurrenceForm(startDay);
  if (!r.editable) return null;
  const f = defaultRecurrenceForm(startDay);
  f.repeat = r.freq as Frequency;
  f.interval = r.interval;
  if (r.byDay.length > 0) f.byDay = sortDays(r.byDay as Weekday[]);
  if (r.count !== null) {
    f.end = 'count';
    f.count = r.count;
  } else if (r.until !== null) {
    f.end = 'until';
    f.until = r.until;
  }
  return f;
}

const UNIT: Record<Frequency, [string, string]> = { DAILY: ['day', 'days'], WEEKLY: ['week', 'weeks'], MONTHLY: ['month', 'months'], YEARLY: ['year', 'years'] };

/** "Every 2 weeks on Mon, Wed, 6 times" — the summary the form and the event show. */
export function describeRecurrence(f: RecurrenceForm): string {
  if (f.repeat === 'none') return 'Does not repeat';
  const [one, many] = UNIT[f.repeat];
  let out = f.interval === 1 ? `Every ${one}` : `Every ${String(f.interval)} ${many}`;
  if (f.repeat === 'WEEKLY' && f.byDay.length > 0) out += ` on ${sortDays(f.byDay).map((d) => WEEKDAY_NAMES[d].short).join(', ')}`;
  if (f.end === 'count') out += `, ${String(f.count)} ${f.count === 1 ? 'time' : 'times'}`;
  if (f.end === 'until') out += `, until ${f.until}`;
  return out;
}
