// PST-T-15.6 (PST-REQ-194): Settings on the canvas. The strength verdict is a pure function; the
// layout rules are held by a source scan, so a settings screen that goes back to a full-width page, a
// hand-rolled field or a Density setting fails here rather than in a screenshot.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { characterClasses, MIN_PASSWORD, scorePassword } from '../../src/settings/password-strength';
import { navEntries } from '../../src/routes';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

/** Every screen a Settings route renders (App.tsx's SCREENS map). */
const SETTINGS_SCREENS = [
  'screens/ChangePassword.tsx',
  'screens/Sessions.tsx',
  'screens/AppPasswords.tsx',
  'screens/DeviceSetup.tsx',
  'screens/Aliases.tsx',
  'screens/Rules.tsx',
  'compose/TemplatesScreen.tsx',
  'screens/Import.tsx',
  'keys/Keys.tsx',
];

describe('scorePassword', () => {
  it('asks for the minimum before anything is typed', () => {
    expect(scorePassword('')).toEqual({ score: 0, label: `At least ${String(MIN_PASSWORD)} characters.` });
  });

  it('is too short under the minimum, and says how far along it is', () => {
    expect(scorePassword('abc')).toEqual({ score: 1, label: 'Too short · 3 of 12 characters' });
    expect(scorePassword('abcdefghijk').score).toBe(1);
  });

  it('calls a long run of the same few characters predictable', () => {
    expect(scorePassword('aaaaaaaaaaaaaaaaaaaa')).toEqual({ score: 1, label: 'Too predictable · 20 characters' });
    expect(scorePassword('abababababababab').score).toBe(1);
  });

  it('meets the minimum at 12, and rises with length and variety — never claiming "Strong"', () => {
    expect(scorePassword('q1w2e3r4t5y6')).toEqual({ score: 2, label: 'Meets the minimum · 12 characters' });
    expect(scorePassword('correcthorsebattery').score).toBe(3);
    expect(scorePassword('Correct horse 12').score).toBe(4);
    // The e2e suite's new password.
    expect(scorePassword('a fresh strong passphrase 2026')).toEqual({ score: 4, label: 'Long and varied · 30 characters' });
    // The server refuses these as common (apps/api common-passwords.ts); the hint must not praise them.
    for (const common of ['1q2w3e4r5t6y7u8i9o0p', '123456789vuonggialong']) expect(scorePassword(common).label).not.toMatch(/strong/i);
  });

  it('flags a password built on a word the server refuses, including the mail domain', () => {
    expect(scorePassword('Postroom-2026!!!!!')).toEqual({ score: 1, label: 'Built on “postroom”, which is refused · 18 characters' });
    expect(scorePassword('my-examplehost-password', undefined, 'examplehost.test').score).toBe(1);
    expect(scorePassword('my-examplehost-password').score).toBeGreaterThan(1);
  });

  it('never goes above 4', () => {
    expect(scorePassword('A very long passphrase, with 3 classes and then some!').score).toBe(4);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(scorePassword('🔑🔑🔑').label).toBe('Too short · 3 of 12 characters');
  });

  it('counts character classes', () => {
    expect(characterClasses('abc')).toBe(1);
    expect(characterClasses('aB3')).toBe(3);
    expect(characterClasses('aB3 ')).toBe(4);
  });
});

describe('the settings grid', () => {
  it('every settings screen is a narrow Page — no full-width settings page', () => {
    for (const file of SETTINGS_SCREENS) {
      const text = read(file);
      expect(text, file).toMatch(/<Page width="narrow"/);
      expect(text, file).not.toMatch(/<Page(>|\s+(?!width="narrow")[a-z]+=)/);
    }
  });

  it('no settings screen offers a Density setting (D-007: one density)', () => {
    for (const file of SETTINGS_SCREENS) expect(read(file), file).not.toMatch(/density/i);
  });

  it('every text field on a settings form is sized to its value, not stretched', () => {
    for (const file of SETTINGS_SCREENS) {
      const text = read(file);
      for (const m of text.matchAll(/<FormField\b([^>]*)>\s*<(Input|PasswordInput|CodeInput)\b/g)) {
        // A modal's single field (the step-up code) sits in the modal's own width.
        const inModal = text.lastIndexOf('<Modal', m.index) > text.lastIndexOf('</Modal>', m.index);
        if (inModal) continue;
        expect(m[1], `${file}: <FormField${m[1] ?? ''}> holds an <${m[2] ?? ''}> with no width`).toMatch(/width="(xs|sm|md|lg)"/);
      }
    }
  });

  it('Settings › Account is the canvas: Profile, Sign-in and Preferences cards of SettingsRows', () => {
    const account = read('screens/ChangePassword.tsx');
    for (const title of ['Profile', 'Sign-in', 'Preferences']) expect(account).toContain(`<Section title="${title}">`);
    expect(account).toContain('<SettingsRow');
    expect(account).toContain('<ThemeSwitch label="Theme"');
    expect(account).toContain('tint="auto"');
    expect(account).toContain('<Badge size="sm">Primary</Badge>');
    // Two-factor status is neutral when on (D-016), attention only when off.
    expect(account).toContain('<StatusDot tone="neutral">On · Authenticator app</StatusDot>');
    expect(account).toContain('<StatusDot tone="attention">Off</StatusDot>');
    // "Change…" opens the form in place: no page of its own.
    expect(account).toMatch(/Change…/);
    expect(account).toContain('<ChangePasswordForm');
    expect(read('App.tsx')).toContain('settingsAccount: <AccountScreen />,');
  });

  it('the change-password form: strength under New, a CodeInput, Sign out other sessions, Cancel / Update', () => {
    const file = read('screens/ChangePassword.tsx');
    const form = file.slice(file.indexOf('export function ChangePasswordForm'), file.indexOf('export function AccountScreen'));
    expect(form).toMatch(/<FormField label="New password" width="lg" help=\{<PasswordStrength /);
    expect(form).toContain('<CodeInput');
    expect(form).toContain('label="Sign out other sessions"');
    expect(form.indexOf('Cancel')).toBeLessThan(form.indexOf('Update password'));
    const css = read('settings/settings.css');
    expect(css).toMatch(/grid-template-columns: 164px minmax\(0, 360px\);/);
  });

  it('the Settings rail names Rules & sorting', () => {
    expect(navEntries('settings', false).map((e) => e.label)).toContain('Rules & sorting');
  });
});
