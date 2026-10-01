// PST-T-17.9 (PST-REQ-194, PST-REQ-155; critique X5, X6, 2.2–2.4): Security & devices on the canvas.
// One constant header — "Security & devices" with one one-line description — on all three tabs, so
// the tab row under it sits at the same y on every tab; the tab row is a <nav> of router links with
// aria-current on the current page, drawn as an underline tab bar that never wraps; each tab's own
// description and call to action live on its first Section card. Layout is held by a source scan and
// the tab bar by rendering it, like settings.test.ts and settings-lists.test.ts.
import { createContext, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mail/CommandPalette', () => ({ PaletteRoleContext: createContext(false) }));

import { SubNav } from '../../src/screens/SubNav';
import { SECURITY_DESCRIPTION } from '../../src/screens/device/security';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

const TABS = ['screens/DeviceSetup.tsx', 'screens/Sessions.tsx', 'screens/AppPasswords.tsx'];

describe('one constant header on every Security & devices tab', () => {
  it.each(TABS)('%s: the same PageHeader, then the tabs, on a centred narrow page', (file) => {
    const text = read(file);
    expect(text).toContain('<Page width="narrow" align="center">');
    expect(text).toContain('<PageHeader title="Security & devices" description={SECURITY_DESCRIPTION} />');
    // Exactly one PageHeader, with no count and no actions: nothing in it changes between tabs.
    expect(text.match(/<PageHeader\b/g)).toHaveLength(1);
    const header = text.slice(text.indexOf('<PageHeader'), text.indexOf('/>', text.indexOf('<PageHeader')));
    expect(header).not.toMatch(/count|actions/);
    expect(text.indexOf('<SubNav />')).toBe(text.indexOf('/>', text.indexOf('<PageHeader')) + '/>\n      '.length);
  });

  it('describes the section in one short line', () => {
    expect(SECURITY_DESCRIPTION).not.toMatch(/\n/);
    // 65ch at 13px is the header's measure; well under it stays one line in the 672px column.
    expect(SECURITY_DESCRIPTION.length).toBeLessThan(65);
  });

  it('each tab says what it is on its first Section, with its call to action there', () => {
    expect(read('screens/DeviceSetup.tsx')).toContain('<Section title="Set up a device" description=');
    expect(read('screens/Sessions.tsx')).toContain('<Section title="Signed in now" description=');
    const passwords = read('screens/AppPasswords.tsx');
    expect(passwords).toMatch(/<Section\s+title="App passwords"\s+description="[^"]+"\s+actions=/);
    // The New button sits in the Section head, before the list, never in the page header.
    const button = passwords.search(/>\s*New app password\s*<\/Button>/);
    expect(button).toBeGreaterThan(passwords.indexOf('<Section'));
    expect(button).toBeLessThan(passwords.indexOf('<DataList'));
    expect(passwords.slice(passwords.indexOf('actions='), button)).toContain('size="sm"');
    // The create form and the one-time reveal open inside that card, not as cards of their own.
    expect(passwords.match(/<Section\b/g)).toHaveLength(1);
  });
});

describe('the Security & devices tab bar', () => {
  const render = (path: string) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(SubNav)));

  it.each([
    ['/settings/security', 'Connect a device'],
    ['/settings/security/sessions', 'Browser sessions'],
    ['/settings/security/devices', 'App passwords'],
  ])('on %s is a nav of the three route links, %s current', (path, current) => {
    const html = render(path);
    expect(html).toMatch(/^<nav aria-label="Security &amp; devices" class="pr-sectabs">/);
    expect(html).not.toContain('pr-subnav');
    const links = [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)];
    expect(links.map((m) => m[2])).toEqual(['Connect a device', 'Browser sessions', 'App passwords']);
    for (const [, attrs, label] of links) {
      expect(attrs).toContain('class="pr-sectabs__link"');
      expect((attrs ?? '').includes('aria-current="page"'), label).toBe(label === current);
    }
  });

  it('never wraps: one row always, scrolling sideways below 768px with 44px targets', () => {
    const css = read('screens/device/security.css');
    expect(css).toMatch(/\.pr-sectabs__list \{[^}]*flex-wrap: nowrap;/);
    const phone = css.slice(css.indexOf('@media (max-width: 767.98px), (max-height: 499px)'));
    expect(phone).toMatch(/\.pr-sectabs__list \{[^}]*overflow-x: auto;/);
    expect(phone).toMatch(/\.pr-sectabs__link \{[^}]*min-height: 44px;/);
    // The current tab is an accent underline on a quiet hairline track, not a filled pill.
    expect(css).toMatch(/\.pr-sectabs__link\[aria-current='page'\] \{[^}]*border-bottom-color: var\(--color-accent\);/);
    expect(css).toMatch(/\.pr-sectabs__list \{[^}]*border-bottom: var\(--border-width\) solid var\(--color-border\);/);
  });
});

describe('Connect a device panels (critique 2.2)', () => {
  it('opens every client on one SettingsRow with its action on the right', () => {
    const panels = read('screens/device/Panels.tsx');
    for (const title of ['iPhone profile', 'Mac profile', 'Thunderbird', 'Any other mail app']) expect(panels).toContain(`title="${title}"`);
    expect(panels).not.toContain('Which device?');
    expect(read('screens/DeviceSetup.tsx')).toContain('className="pr-device-tabs"');
  });
});
