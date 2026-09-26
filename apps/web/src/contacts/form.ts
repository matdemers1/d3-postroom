// The contact form's state ↔ the API's contact (PST-REQ-137). Pure, so it is unit-tested.
import type { ContactDetail, ContactInput } from '../api';

export interface ContactForm {
  fn: string;
  given: string;
  family: string;
  org: string;
  note: string;
  /** `type` is a TYPE value, or 'none'. `key` only keeps React rows stable. */
  emails: { key: string; address: string; type: string }[];
  tels: { key: string; value: string; type: string }[];
}

export const EMAIL_TYPES = [
  { value: 'none', label: 'No label' },
  { value: 'home', label: 'Home' },
  { value: 'work', label: 'Work' },
  { value: 'other', label: 'Other' },
];

export const TEL_TYPES = [
  { value: 'cell', label: 'Mobile' },
  { value: 'home', label: 'Home' },
  { value: 'work', label: 'Work' },
  { value: 'none', label: 'No label' },
];

let seq = 0;
/** A fresh key for a form row. */
export const rowKey = (): string => `row-${String(++seq)}`;
const key = rowKey;

/** The options for a type select: the known labels, plus the card's own label if it is another one. */
export function typeOptions(base: readonly { value: string; label: string }[], current: string): { value: string; label: string }[] {
  return base.some((o) => o.value === current) ? [...base] : [...base, { value: current, label: current.charAt(0).toUpperCase() + current.slice(1) }];
}

export function blankContact(): ContactForm {
  return { fn: '', given: '', family: '', org: '', note: '', emails: [{ key: key(), address: '', type: 'none' }], tels: [] };
}

export function toForm(c: ContactDetail): ContactForm {
  return {
    fn: c.fn,
    given: c.given,
    family: c.family,
    org: c.org,
    note: c.note,
    emails: c.emails.map((e) => ({ key: key(), address: e.address, type: e.type ?? 'none' })),
    tels: c.tels.map((t) => ({ key: key(), value: t.value, type: t.type ?? 'none' })),
  };
}

/** What the API is sent: blank rows dropped, 'none' as no TYPE. */
export function inputOf(f: ContactForm): ContactInput {
  const typeOf = (t: string): string | null => (t === 'none' || t.trim() === '' ? null : t);
  return {
    fn: f.fn.trim(),
    given: f.given.trim(),
    family: f.family.trim(),
    org: f.org.trim(),
    note: f.note,
    emails: f.emails.filter((e) => e.address.trim() !== '').map((e) => ({ address: e.address.trim(), type: typeOf(e.type) })),
    tels: f.tels.filter((t) => t.value.trim() !== '').map((t) => ({ value: t.value.trim(), type: typeOf(t.type) })),
  };
}

/** A problem the form can name before asking the server, or null. */
export function contactProblem(f: ContactForm): string | null {
  const input = inputOf(f);
  if ([input.fn, input.given, input.family, input.org].every((x) => x === '') && input.emails.length === 0) return 'Give the contact a name, an organisation or an e-mail address.';
  const bad = input.emails.find((e) => !/^[^\s@<>]+@[^\s@<>]+$/.test(e.address));
  if (bad !== undefined) return `“${bad.address}” is not an e-mail address.`;
  return null;
}
