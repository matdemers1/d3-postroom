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

// PST-T-17.11 (PST-REQ-194, PST-REQ-155): Import on the canvas.
import { folderCount, folderState, importFormProblem, importState, importTitle, isActive } from '../../src/screens/import/status';

const imp = (status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled', error: string | null = null) => ({ status, error });

describe('the Import page (PST-T-17.11)', () => {
  it('says where an import stands as a dot and a word, coloured only when it needs you', () => {
    expect(importState(imp('pending'))).toEqual({ tone: 'neutral', label: 'Waiting to start' });
    expect(importState(imp('running'))).toEqual({ tone: 'neutral', label: 'Importing' });
    expect(importState(imp('running', 'connection reset'))).toEqual({ tone: 'attention', label: 'Interrupted, resuming' });
    expect(importState(imp('done'))).toEqual({ tone: 'neutral', label: 'Finished' });
    expect(importState(imp('failed', 'bad password'))).toEqual({ tone: 'danger', label: 'Failed' });
    expect(importState(imp('cancelled'))).toEqual({ tone: 'idle', label: 'Canceled' });
  });

  it('titles the card by what it is now', () => {
    expect(importTitle(imp('running'))).toBe('Import in progress');
    expect(importTitle(imp('pending'))).toBe('Import in progress');
    expect(importTitle(imp('done'))).toBe('Last import');
    expect(isActive(null)).toBe(false);
    expect(isActive(undefined)).toBe(false);
    expect(isActive(imp('failed'))).toBe(false);
  });

  it('says each folder is done, waiting, or not finished', () => {
    expect(folderState({ done: true }, imp('running'))).toEqual({ tone: 'neutral', label: 'Done' });
    expect(folderState({ done: false }, imp('running'))).toEqual({ tone: 'idle', label: 'Waiting' });
    expect(folderState({ done: false }, imp('cancelled'))).toEqual({ tone: 'idle', label: 'Not finished' });
    expect(folderCount({ imported: 10, duplicates: 2, total: 40 })).toBe('12 of 40 (2 already here)');
    expect(folderCount({ imported: 3, duplicates: 0, total: 3 })).toBe('3 of 3');
  });

  it('checks the form without asking for a code: the step-up is the modal’s', () => {
    const ok = { host: 'imap.fastmail.com', port: '993', username: 'me@fastmail.com', password: 'pw' };
    expect(importFormProblem(ok)).toBeNull();
    expect(importFormProblem({ ...ok, host: ' ' })).toMatch(/Enter the server/);
    expect(importFormProblem({ ...ok, password: '' })).toMatch(/Enter the server/);
    for (const port of ['', '0', '65536', '99.5', 'imap']) expect(importFormProblem({ ...ok, port }), port).toMatch(/The port is a number/);
  });

  it('is the canvas: one form card on the 164/360 grid, the code asked in Confirm it is you, no empty state above it', () => {
    const page = readFileSync(join(__dirname, '../../src/screens/Import.tsx'), 'utf8');
    expect(page).toContain('<PageHeader title="Import"');
    expect(page).toContain('<Page width="narrow" align="center">');
    expect(page).toContain('className="pr-setform"');
    expect(page).toMatch(/<div className="pr-setform__pair">\s*<FormField label="Server"[\s\S]*?<FormField label="Port"/);
    expect(page).toMatch(/<SettingsRow\s+className="pr-setform__disclosure"\s+title="Advanced"/);
    expect(page).toMatch(/<FormActions className="pr-setform__actions">\s*<Button type="submit" variant="primary"/);
    // The second factor is asked when the import starts, in the shared step-up modal.
    expect(page).not.toMatch(/label="Authentication code"|one-time-code|api\.stepUp/);
    expect(page).toContain('startImport(withStepUp, () => importApi.start(input()))');
    // A cancelled step-up leaves the form as it was: only a started import clears the password.
    const submit = page.slice(page.indexOf('const submit = '), page.indexOf('const cancel = '));
    expect(submit).toMatch(/if \(outcome\.kind === 'cancelled'\) return;/);
    expect(submit.indexOf("setPassword('')")).toBeGreaterThan(submit.indexOf("outcome.kind === 'failed'"));
    expect(page).not.toMatch(/<EmptyState\b/);
    expect(page).not.toMatch(/<Badge\b/);
  });

  it('defines the one shared settings form grid: 164px labels, a 360px field column, one column below 768px', () => {
    const css = readFileSync(join(__dirname, '../../src/settings/settings.css'), 'utf8');
    const desktop = css.slice(css.indexOf('@media (min-width: 768px) and (min-height: 500px) {\n  .pr-setform'));
    expect(desktop.length).toBeGreaterThan(0);
    expect(desktop).toMatch(/\.pr-setform \.d3-ff \{\s*display: grid;\s*grid-template-columns: 164px minmax\(0, 360px\);/);
    // Outside that media query a .pr-setform field is FormField's own single column.
    const base = css.slice(0, css.indexOf('@media (min-width: 768px) and (min-height: 500px) {\n  .pr-setform'));
    expect(base).not.toMatch(/\.pr-setform \.d3-ff \{[^}]*display: grid/);
    // The old change-password grid is still there for Account.
    expect(css).toContain('.pr-pwform .d3-ff');
  });
});
