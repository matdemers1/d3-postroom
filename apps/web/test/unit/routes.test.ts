// PST-T-14.3 (PST-REQ-189, PST-ADR-011): one route table defines every screen — its path, title,
// place, nav group, palette keywords and whether it is admin-only — and both navs, the tab title and
// the palette are generated from it. These pin its shape; the browser side is e2e/tests/places.spec.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { navEntries, paletteRoutes, placeForPath, redirectForOldPath, REDIRECTS, routeForPath, ROUTES } from '../../src/routes';

describe('the route table', () => {
  it('declares every field for every screen, with no path twice', () => {
    const paths = ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const route of ROUTES) {
      expect(route.title.length, route.id).toBeGreaterThan(0);
      expect(['mail', 'settings', 'admin', 'auth']).toContain(route.place);
      expect(typeof route.adminOnly).toBe('boolean');
      expect(typeof route.keywords).toBe('string');
    }
  });

  it('keeps every Admin console route admin-only, and nothing else', () => {
    for (const route of ROUTES) expect(route.adminOnly, route.id).toBe(route.place === 'admin');
    for (const route of ROUTES.filter((r) => r.place === 'admin')) expect(route.path.startsWith('/admin/')).toBe(true);
    for (const route of ROUTES.filter((r) => r.place === 'settings')) expect(route.path.startsWith('/settings/')).toBe(true);
  });

  it("Mail's nav holds only the Calendar and Contacts places beyond the mailboxes", () => {
    expect(navEntries('mail', true).map((e) => e.label)).toEqual(['Calendar', 'Contacts']);
  });

  it('Settings has its own seven-entry nav', () => {
    expect(navEntries('settings', false).map((e) => e.label)).toEqual([
      'Account',
      'Security & devices',
      'Addresses',
      'Rules & sorting',
      'Templates',
      'Import',
      'Encryption keys',
    ]);
    const security = navEntries('settings', false).find((e) => e.label === 'Security & devices');
    expect(security?.path).toBe('/settings/security');
    expect(security?.routes.map((r) => r.title)).toEqual(['Connect a device', 'Browser sessions', 'App passwords']);
  });

  it('Security & devices opens on device setup, with Browser sessions after it (PST-DA-053)', () => {
    expect(routeForPath('/settings/security')?.id).toBe('settingsDeviceSetup');
    expect(routeForPath('/settings/security/sessions')?.id).toBe('settingsBrowsers');
    const security = navEntries('settings', false).find((e) => e.label === 'Security & devices');
    expect(security?.routes[0]?.id).toBe('settingsDeviceSetup');
    expect(security?.routes[1]?.id).toBe('settingsBrowsers');
  });

  it('the Admin console has its own nav, and none at all for a non-admin', () => {
    expect(navEntries('admin', true).map((e) => e.label)).toEqual([
      'Health',
      'Outbound queue',
      'Deliverability',
      'DNS & DKIM',
      'Live SMTP',
      'Jobs',
      'Sign-in sessions',
      'Sign in with D3 Auth',
      'Suppressions',
      'Setup',
    ]);
    expect(navEntries('admin', false)).toEqual([]);
  });

  it('no two nav labels collide across places (no more Sessions / Devices / SMTP sessions)', () => {
    const labels = (['mail', 'settings', 'admin'] as const).flatMap((p) => navEntries(p, true).map((e) => e.label));
    expect(new Set(labels).size).toBe(labels.length);
    const titles = ROUTES.filter((r) => r.palette).map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('finds the route for a pathname, literal before parameter', () => {
    expect(routeForPath('/')?.id).toBe('mail');
    expect(routeForPath('/mail')?.id).toBe('mailFolder');
    expect(routeForPath('/mail/a/b')?.id).toBe('mailFolder');
    expect(routeForPath('/contacts/new')?.id).toBe('contactNew');
    expect(routeForPath('/contacts/book/card')?.id).toBe('contactCard');
    expect(routeForPath('/settings/security/devices')?.id).toBe('settingsDevices');
    expect(routeForPath('/admin/nope')).toBeNull();
    expect(placeForPath('/settings/rules')).toBe('settings');
    expect(placeForPath('/admin/health')).toBe('admin');
    expect(placeForPath('/calendar')).toBe('mail');
  });

  it('the palette reaches every destination: all non-parameter shell routes', () => {
    const reachable = paletteRoutes(true).map((r) => r.path);
    for (const route of ROUTES) {
      if (route.place === 'auth' || route.path.includes(':') || route.path.includes('*') || route.id === 'mail' || route.id === 'contactNew') continue;
      expect(reachable, route.path).toContain(route.path);
    }
  });
});

describe('redirects from the old URLs', () => {
  const OLD = [
    ['/app-passwords', '/settings/security/devices'],
    ['/account/aliases', '/settings/addresses'],
    ['/account/password', '/settings/account'],
    ['/account/sessions', '/settings/security/sessions'],
    ['/account/import', '/settings/import'],
    ['/account/device-setup', '/settings/security'],
    ['/settings/security/device-setup', '/settings/security'],
    ['/account/rules', '/settings/rules'],
    ['/account/templates', '/settings/templates'],
    ['/account/keys', '/settings/keys'],
    ['/admin', '/admin/health'],
    ['/settings', '/settings/account'],
  ] as const;

  it('sends every pre-PST-T-14.3 URL to its new home', () => {
    for (const [from, to] of OLD) expect(redirectForOldPath(from), from).toBe(to);
    expect(redirectForOldPath('/account/keys/')).toBe('/settings/keys');
    expect(redirectForOldPath('/admin/health')).toBeNull();
  });

  it('only ever points at a route that exists, and never at another redirect', () => {
    for (const r of REDIRECTS) {
      expect(routeForPath(r.to), r.to).not.toBeNull();
      expect(routeForPath(r.from), r.from).toBeNull();
    }
  });
});

// PST-T-17.8 (critique-settings X4): a nav label is the page's h1. e2e/tests/titles.spec.ts checks
// that in the browser from its own copy of the list (it cannot import this table); this keeps the copy
// honest — every Settings and Admin route, in table order, with its nav label.
describe('the page-title e2e list', () => {
  it('names the nav entry "Import", not "Import & export" (there is no export)', () => {
    expect(routeForPath('/settings/import')?.navGroup).toBe('Import');
    expect(routeForPath('/settings/import')?.title).toBe('Import');
    expect(ROUTES.some((r) => r.navGroup === 'Import & export' || r.title === 'Import & export')).toBe(false);
  });

  it('every route outside Security & devices is titled with its nav label', () => {
    for (const route of ROUTES.filter((r) => (r.place === 'settings' || r.place === 'admin') && r.navGroup !== 'Security & devices')) {
      expect(route.title, route.id).toBe(route.navGroup);
    }
  });

  it('matches the route table', () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/tests/titles.spec.ts'), 'utf8');
    const listed = [...spec.matchAll(/^ {2}\['(\/(?:settings|admin)\/[^']*)', '([^']+)'\],$/gm)].map((m) => [m[1], m[2]]);
    const expected = ROUTES.filter((r) => r.place === 'settings' || r.place === 'admin').map((r) => [r.path, r.navGroup ?? r.title]);
    expect(listed).toEqual(expected);
  });
});
