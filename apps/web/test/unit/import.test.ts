// PST-T-16.8 (PST-DA-046): the provider presets behind "Import mail".
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMPORT_PRESETS, OTHER_PRESET_ID, presetById, presetForAddress, presetForHost } from '../../src/screens/import/presets';

describe('import presets', () => {
  it('offers Gmail, iCloud, Outlook / Microsoft 365, Fastmail and Other', () => {
    expect(IMPORT_PRESETS.map((p) => p.label)).toEqual(['Gmail', 'iCloud', 'Outlook / Microsoft 365', 'Fastmail', 'Other']);
  });

  it('fills IMAP over TLS on 993 with the provider’s server', () => {
    expect(IMPORT_PRESETS.map((p) => [p.id, p.host, p.port])).toEqual([
      ['gmail', 'imap.gmail.com', '993'],
      ['icloud', 'imap.mail.me.com', '993'],
      ['outlook', 'outlook.office365.com', '993'],
      ['fastmail', 'imap.fastmail.com', '993'],
      ['other', '', '993'],
    ]);
  });

  it.each([
    ['me@gmail.com', 'gmail'],
    ['me@GoogleMail.com', 'gmail'],
    ['me@icloud.com', 'icloud'],
    ['me@me.com', 'icloud'],
    ['me@mac.com', 'icloud'],
    ['me@outlook.com', 'outlook'],
    ['me@hotmail.com', 'outlook'],
    ['me@live.com', 'outlook'],
    ['me@fastmail.com', 'fastmail'],
    ['  me@fastmail.fm ', 'fastmail'],
  ])('%s picks %s', (address, id) => {
    expect(presetForAddress(address)?.id).toBe(id);
  });

  it('leaves an unknown domain, a bare name and a half-typed address alone', () => {
    for (const value of ['me@example.org', 'me', 'me@', '@gmail.com', 'me@gmail.com.evil.example', '']) {
      expect(presetForAddress(value)).toBeUndefined();
    }
  });

  it('reads a server that matches no preset as Other', () => {
    expect(presetForHost('imap.gmail.com').id).toBe('gmail');
    expect(presetForHost(' IMAP.Gmail.com ').id).toBe('gmail');
    expect(presetForHost('mail.example.org').id).toBe(OTHER_PRESET_ID);
    expect(presetForHost('').id).toBe(OTHER_PRESET_ID);
  });

  it('warns that Gmail and iCloud need an app-specific password, and the others do not', () => {
    expect(presetById('gmail')?.passwordHint).toMatch(/app-specific password/);
    expect(presetById('icloud')?.passwordHint).toMatch(/app-specific password/);
    expect(presetById('fastmail')?.passwordHint).toBeUndefined();
  });

  it('makes no network call to autodiscover (PST-REQ-175)', () => {
    const source = readFileSync(join(__dirname, '../../src/screens/import/presets.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|https?:\/\//);
  });
});
