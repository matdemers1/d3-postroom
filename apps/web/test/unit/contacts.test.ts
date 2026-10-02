// PST-T-8.5 (PST-REQ-137): the contact form ↔ the API's contact.
import { describe, expect, it } from 'vitest';
import type { ContactDetail } from '../../src/api';
import { blankContact, canRemoveRow, contactProblem, EMAIL_TYPES, inputOf, toForm, typeOptions } from '../../src/contacts/form';

const DETAIL: ContactDetail = {
  addressBookId: 'b',
  name: 'n.vcf',
  etag: 'e',
  uid: 'u',
  displayName: 'Grace Hopper',
  fn: 'Grace Hopper',
  given: 'Grace',
  family: 'Hopper',
  emails: [
    { address: 'grace@navy.example', type: 'work' },
    { address: 'g@example.org', type: null },
  ],
  tels: [{ value: '+1 555 0199', type: 'x-pager' }],
  org: 'US Navy',
  note: 'COBOL',
  hasPhoto: true,
};

describe('contact form', () => {
  it('round-trips a contact, labels included', () => {
    const f = toForm(DETAIL);
    expect(f.emails.map((e) => e.type)).toEqual(['work', 'none']);
    expect(inputOf(f)).toEqual({
      fn: 'Grace Hopper',
      given: 'Grace',
      family: 'Hopper',
      org: 'US Navy',
      note: 'COBOL',
      emails: [
        { address: 'grace@navy.example', type: 'work' },
        { address: 'g@example.org', type: null },
      ],
      tels: [{ value: '+1 555 0199', type: 'x-pager' }],
    });
  });

  it('drops blank rows and trims', () => {
    const f = { ...blankContact(), given: '  Ada ', emails: [{ key: 'a', address: ' ada@example.org ', type: 'home' }, { key: 'b', address: '  ', type: 'none' }] };
    expect(inputOf(f)).toMatchObject({ given: 'Ada', emails: [{ address: 'ada@example.org', type: 'home' }], tels: [] });
  });

  it('names what is wrong before the server does', () => {
    expect(contactProblem(blankContact())).toMatch(/name, an organization or an email/);
    expect(contactProblem({ ...blankContact(), emails: [{ key: 'a', address: 'not an address', type: 'none' }] })).toMatch(/not an email address/);
    expect(contactProblem({ ...blankContact(), org: 'Acme' })).toBeNull();
  });

  it('keeps a label the phone set that the form does not offer', () => {
    expect(typeOptions(EMAIL_TYPES, 'work')).toHaveLength(EMAIL_TYPES.length);
    expect(typeOptions(EMAIL_TYPES, 'x-school').at(-1)).toEqual({ value: 'x-school', label: 'X-school' });
  });
});

// PST-T-17.5 (PST-DA-083): an empty email or phone row has no Remove until it has a value or has company.
describe('canRemoveRow', () => {
  it('hides Remove on a lone empty row', () => {
    expect(canRemoveRow(blankContact().emails, '')).toBe(false);
    expect(canRemoveRow([{}], '   ')).toBe(false);
  });

  it('shows Remove once the row has a value', () => {
    expect(canRemoveRow([{}], 'a@b.com')).toBe(true);
  });

  it('shows Remove on every row when there is more than one', () => {
    expect(canRemoveRow([{}, {}], '')).toBe(true);
  });
});
