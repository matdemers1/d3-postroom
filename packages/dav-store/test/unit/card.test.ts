// PST-T-8.5: the contact form's fields ↔ vCard, and the harvest's pure rules.
import { describe, expect, it } from 'vitest';
import { getProperties, getProperty, parseVCard, serializeVCard } from '@postroom/vcard';
import { applyContactFields, buildContactCard, collectedUid, contactOf, isNoReplyAddress, revStamp } from '../../src/index.js';

const NOW = new Date('2026-09-26T10:15:00.123Z');
const FIELDS = {
  fn: '',
  given: 'Ada',
  family: 'Lovelace',
  emails: [
    { address: 'ada@example.org', type: 'work' },
    { address: 'ada@home.example', type: null },
  ],
  tels: [{ value: '+1 555 0100', type: 'cell' }],
  org: 'Analytical, Engines',
  note: 'Line one\nLine two; with a comma, too',
};

describe('contact cards (PST-REQ-137)', () => {
  it('builds a vCard 3.0 that re-parses to the same fields', () => {
    const text = serializeVCard(buildContactCard('UID-1', FIELDS, NOW));
    expect(text).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
    expect(text).toContain('FN:Ada Lovelace\r\n');
    expect(text).toContain('N:Lovelace;Ada;;;\r\n');
    expect(text).toContain('EMAIL;TYPE=INTERNET,WORK,pref:ada@example.org\r\n');
    expect(text).toContain('REV:20260926T101500Z\r\n');
    const view = contactOf(parseVCard(text));
    expect(view).toMatchObject({
      fn: 'Ada Lovelace',
      given: 'Ada',
      family: 'Lovelace',
      emails: [
        { address: 'ada@example.org', type: 'work' },
        { address: 'ada@home.example', type: null },
      ],
      tels: [{ value: '+1 555 0100', type: 'cell' }],
      org: 'Analytical, Engines',
      note: 'Line one\nLine two; with a comma, too',
      displayName: 'Ada Lovelace',
      hasPhoto: false,
    });
  });

  it('an edit replaces only the form’s fields and keeps the photo, addresses and custom properties', () => {
    const phone = parseVCard(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'PRODID:-//Apple Inc.//iPhone OS 26.0//EN',
        'N:Old;Name;;;',
        'FN:Old Name',
        'item1.EMAIL;type=INTERNET:old@example.org',
        'item1.X-ABLabel:_$!<Other>!$_',
        'item2.ADR;type=HOME:;;1 Main St;Town;;12345;',
        'item2.X-ABLabel:_$!<Home>!$_',
        'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ',
        'BDAY:1815-12-10',
        'UID:PHONE-UID',
        'END:VCARD',
        '',
      ].join('\r\n'),
    );
    const edited = applyContactFields(phone, { ...FIELDS, emails: [{ address: 'new@example.org', type: null }] }, NOW);
    expect(getProperty(edited, 'PHOTO')?.value).toBe('/9j/4AAQ');
    expect(getProperty(edited, 'BDAY')?.value).toBe('1815-12-10');
    expect(getProperty(edited, 'UID')?.value).toBe('PHONE-UID');
    expect(getProperty(edited, 'ADR')?.group).toBe('item2');
    // The label of the removed grouped EMAIL goes with it; the ADR's stays.
    expect(getProperties(edited, 'X-ABLABEL').map((p) => p.group)).toEqual(['item2']);
    expect(contactOf(edited)).toMatchObject({ fn: 'Ada Lovelace', emails: [{ address: 'new@example.org', type: null }], hasPhoto: true });
    expect(getProperties(edited, 'VERSION').map((p) => p.value)).toEqual(['3.0']);
    // Serialises and re-parses.
    expect(contactOf(parseVCard(serializeVCard(edited))).emails).toEqual([{ address: 'new@example.org', type: null }]);
  });

  it('derives a formatted name when the form leaves it blank', () => {
    const only = (f: Partial<typeof FIELDS>) => contactOf(buildContactCard('u', { ...FIELDS, fn: '', given: '', family: '', org: '', emails: [], ...f }, NOW)).fn;
    expect(only({ org: 'Acme' })).toBe('Acme');
    expect(only({ emails: [{ address: 'x@example.org', type: null }] })).toBe('x@example.org');
    expect(only({ fn: '  Explicit  ' })).toBe('Explicit');
  });

  it('stamps REV in UTC basic format', () => {
    expect(revStamp(NOW)).toBe('20260926T101500Z');
  });
});

describe('harvest rules (PST-REQ-138)', () => {
  it('knows the addresses that never answer', () => {
    for (const a of ['noreply@x.example', 'no-reply@x.example', 'No_Reply@x.example', 'donotreply@x.example', 'do-not-reply@x.example', 'mailer-daemon@x.example', 'postmaster@x.example', 'bounces+abc@x.example', 'noreply-alerts@x.example']) {
      expect(isNoReplyAddress(a), a).toBe(true);
    }
    for (const a of ['nora@x.example', 'reply@x.example', 'alice@x.example', 'replyall@x.example', 'noreplyguy@x.example']) {
      expect(isNoReplyAddress(a), a).toBe(false);
    }
  });

  it('gives one address one UID, whatever its case', () => {
    expect(collectedUid('Alice@Example.org')).toBe(collectedUid(' alice@example.org '));
    expect(collectedUid('alice@example.org')).not.toBe(collectedUid('bob@example.org'));
    expect(collectedUid('alice@example.org')).toMatch(/^postroom-collected-[0-9a-f]{32}$/);
  });
});
