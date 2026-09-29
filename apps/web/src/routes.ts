// The route table (PST-T-14.3, PST-REQ-189, PST-ADR-011): every screen Postroom has, declared once.
// App.tsx builds its <Routes> from it, Shell.tsx builds the Mail, Settings and Admin console navs
// from it, title.ts names the tab from it and the ⌘K palette lists its entries — so a label is
// changed in one place and can never drift into "Sessions / Devices / SMTP sessions" again.
// Pure and DOM-free, so it is unit-tested.
import type { MailAction } from './mail/keys';

/** The three places, plus the two shell-less pages before you are signed in. */
export type Place = 'mail' | 'settings' | 'admin' | 'auth';

export type RouteId =
  | 'setup'
  | 'signin'
  | 'mail'
  | 'mailFolder'
  | 'calendar'
  | 'contacts'
  | 'contactNew'
  | 'contactCard'
  | 'sender'
  | 'settingsAccount'
  | 'settingsBrowsers'
  | 'settingsDevices'
  | 'settingsDeviceSetup'
  | 'settingsAddresses'
  | 'settingsRules'
  | 'settingsTemplates'
  | 'settingsImport'
  | 'settingsKeys'
  | 'adminHealth'
  | 'adminQueue'
  | 'adminDeliverability'
  | 'adminDns'
  | 'adminSmtp'
  | 'adminJobs'
  | 'adminSessions'
  | 'adminSuppressions'
  | 'adminSetup';

export interface AppRoute {
  id: RouteId;
  /** A React Router pattern: literal segments, `:param` segments, and an optional trailing `*`. */
  path: string;
  /** The screen's name: the tab title, and its palette entry. */
  title: string;
  place: Place;
  /** The left-nav entry this screen sits under. Several routes may share one entry (Security &
   * devices has three); the entry links to the first of them. Absent: not in any left nav. */
  navGroup?: string;
  /** Extra words the palette matches — the old names survive here as searchable hints. */
  keywords: string;
  /** A one-line hint shown beside the palette entry. */
  hint?: string;
  /** Only an admin account sees it in a nav or the palette (the server enforces it regardless). */
  adminOnly: boolean;
  /** False for routes that need a parameter or are not a destination of their own. */
  palette: boolean;
  /** A keys.ts binding that reaches this screen, shown as its keycaps. */
  shortcut?: MailAction;
}

const r = (route: Omit<AppRoute, 'adminOnly' | 'palette' | 'keywords'> & Partial<Pick<AppRoute, 'adminOnly' | 'palette' | 'keywords'>>): AppRoute => ({
  adminOnly: false,
  palette: true,
  keywords: '',
  ...route,
});

/** In nav order within each place. */
export const ROUTES: readonly AppRoute[] = [
  r({ id: 'setup', path: '/setup', title: 'Setup', place: 'auth', palette: false }),
  r({ id: 'signin', path: '/signin', title: 'Sign in', place: 'auth', palette: false }),

  // Mail. The mailboxes themselves are data, not routes — the sidebar and the palette list them.
  r({ id: 'mail', path: '/', title: 'Mail', place: 'mail', palette: false, shortcut: 'goInbox' }),
  r({ id: 'mailFolder', path: '/mail/*', title: 'Mail', place: 'mail', palette: false }),
  r({ id: 'calendar', path: '/calendar', title: 'Calendar', place: 'mail', navGroup: 'Calendar', keywords: 'events schedule caldav' }),
  r({ id: 'contacts', path: '/contacts', title: 'Contacts', place: 'mail', navGroup: 'Contacts', keywords: 'people address book carddav' }),
  r({ id: 'contactNew', path: '/contacts/new', title: 'Contacts', place: 'mail', navGroup: 'Contacts', palette: false }),
  r({ id: 'contactCard', path: '/contacts/:addressBookId/:name', title: 'Contacts', place: 'mail', navGroup: 'Contacts', palette: false }),
  r({ id: 'sender', path: '/senders/:address', title: 'Sender', place: 'mail', palette: false }),

  // Settings: your account, reached from the account menu.
  r({ id: 'settingsAccount', path: '/settings/account', title: 'Account', place: 'settings', navGroup: 'Account', keywords: 'profile change password', hint: 'Name, change password' }),
  r({
    id: 'settingsBrowsers',
    path: '/settings/security',
    title: 'Browser sessions',
    place: 'settings',
    navGroup: 'Security & devices',
    keywords: 'security devices signed in sign out web sessions',
    hint: 'Where you are signed in on the web',
  }),
  r({
    id: 'settingsDevices',
    path: '/settings/security/devices',
    title: 'Devices',
    place: 'settings',
    navGroup: 'Security & devices',
    keywords: 'security app passwords mail apps iphone thunderbird',
    hint: 'Mail apps and their app passwords',
  }),
  r({
    id: 'settingsDeviceSetup',
    path: '/settings/security/device-setup',
    title: 'Set up iPhone / Mac',
    place: 'settings',
    navGroup: 'Security & devices',
    keywords: 'security devices configuration profile mobileconfig ios macos',
    hint: 'Download a configuration profile',
  }),
  r({ id: 'settingsAddresses', path: '/settings/addresses', title: 'Addresses', place: 'settings', navGroup: 'Addresses', keywords: 'aliases masked aliases', hint: 'Aliases, masked aliases' }),
  r({ id: 'settingsRules', path: '/settings/rules', title: 'Rules', place: 'settings', navGroup: 'Rules', keywords: 'filters sieve' }),
  r({ id: 'settingsTemplates', path: '/settings/templates', title: 'Templates', place: 'settings', navGroup: 'Templates', keywords: 'compose templates canned replies' }),
  r({ id: 'settingsImport', path: '/settings/import', title: 'Import & export', place: 'settings', navGroup: 'Import & export', keywords: 'import mail imap migrate' }),
  r({ id: 'settingsKeys', path: '/settings/keys', title: 'Encryption keys', place: 'settings', navGroup: 'Encryption keys', keywords: 'keys openpgp pgp s/mime smime certificates' }),

  // The Admin console: admins only, reached from the account menu.
  r({ id: 'adminHealth', path: '/admin/health', title: 'Health', place: 'admin', navGroup: 'Health', adminOnly: true, keywords: 'status daemons backups disk' }),
  r({ id: 'adminQueue', path: '/admin/queue', title: 'Outbound queue', place: 'admin', navGroup: 'Outbound queue', adminOnly: true, keywords: 'deferred retry delivery outbox' }),
  r({ id: 'adminDeliverability', path: '/admin/deliverability', title: 'Deliverability', place: 'admin', navGroup: 'Deliverability', adminOnly: true, keywords: 'dmarc reports bounces reputation' }),
  r({ id: 'adminDns', path: '/admin/dns', title: 'DNS & DKIM', place: 'admin', navGroup: 'DNS & DKIM', adminOnly: true, keywords: 'dns records spf dkim dmarc mx' }),
  r({ id: 'adminSmtp', path: '/admin/smtp', title: 'Live SMTP', place: 'admin', navGroup: 'Live SMTP', adminOnly: true, keywords: 'smtp sessions transcripts', hint: 'SMTP transcripts (was “SMTP sessions”)' }),
  r({ id: 'adminJobs', path: '/admin/jobs', title: 'Jobs', place: 'admin', navGroup: 'Jobs', adminOnly: true, keywords: 'queue replay failed pipeline' }),
  r({ id: 'adminSessions', path: '/admin/sessions', title: 'Sign-in sessions', place: 'admin', navGroup: 'Sign-in sessions', adminOnly: true, keywords: 'sessions devices accounts', hint: 'Every account’s web sign-ins (was “Sessions”)' }),
  r({ id: 'adminSuppressions', path: '/admin/suppressions', title: 'Suppressions', place: 'admin', navGroup: 'Suppressions', adminOnly: true, keywords: 'suppression list bounces blocked' }),
  r({ id: 'adminSetup', path: '/admin/setup', title: 'Setup', place: 'admin', navGroup: 'Setup', adminOnly: true, keywords: 'setup wizard domain first run' }),
];

/** Old URLs, kept working (bookmarks, runbooks, links in old mail). Every target is a route above. */
export const REDIRECTS: readonly { from: string; to: string }[] = [
  { from: '/app-passwords', to: '/settings/security/devices' },
  { from: '/account', to: '/settings/account' },
  { from: '/account/password', to: '/settings/account' },
  { from: '/account/sessions', to: '/settings/security' },
  { from: '/account/device-setup', to: '/settings/security/device-setup' },
  { from: '/account/aliases', to: '/settings/addresses' },
  { from: '/account/rules', to: '/settings/rules' },
  { from: '/account/templates', to: '/settings/templates' },
  { from: '/account/import', to: '/settings/import' },
  { from: '/account/keys', to: '/settings/keys' },
  { from: '/settings', to: '/settings/account' },
  { from: '/admin', to: '/admin/health' },
];

export const PLACE_HOME: Readonly<Record<'settings' | 'admin', string>> = {
  settings: '/settings/account',
  admin: '/admin/health',
};

export const PLACE_NAME: Readonly<Record<Place, string>> = {
  mail: 'Mail',
  settings: 'Settings',
  admin: 'Admin console',
  auth: 'Postroom',
};

function matches(pattern: string, pathname: string): boolean {
  const want = pattern.split('/').filter((s) => s !== '');
  const got = pathname.split('/').filter((s) => s !== '');
  for (let i = 0; i < want.length; i++) {
    const seg = want[i] ?? '';
    if (seg === '*') return true;
    const part = got[i];
    if (part === undefined) return false;
    if (seg.startsWith(':')) continue;
    if (seg !== part) return false;
  }
  return want.length === got.length;
}

/** The route a pathname shows, or null. Literal routes win over parameter ones ('/contacts/new'). */
export function routeForPath(pathname: string): AppRoute | null {
  // Most specific first: a pattern with fewer parameters and no splat beats one with more.
  const specificity = (p: string): number => (p.includes('*') ? 100 : 0) + (p.match(/:/g)?.length ?? 0);
  const candidates = ROUTES.filter((route) => matches(route.path, pathname));
  candidates.sort((a, b) => specificity(a.path) - specificity(b.path));
  return candidates[0] ?? null;
}

/** Where an old URL now lives, or null. */
export function redirectForOldPath(pathname: string): string | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return REDIRECTS.find((r) => r.from === trimmed)?.to ?? null;
}

/** The place a pathname belongs to; anything unknown is Mail (App.tsx sends it to '/'). */
export function placeForPath(pathname: string): Place {
  return routeForPath(pathname)?.place ?? 'mail';
}

export interface NavEntry {
  label: string;
  /** Where the entry links: its first route. */
  path: string;
  /** Every route under the entry, in order. */
  routes: AppRoute[];
}

/** A place's left-nav entries, in table order, filtered by role. */
export function navEntries(place: Place, isAdmin: boolean): NavEntry[] {
  const entries: NavEntry[] = [];
  for (const route of ROUTES) {
    if (route.place !== place || route.navGroup === undefined) continue;
    if (route.adminOnly && !isAdmin) continue;
    const existing = entries.find((e) => e.label === route.navGroup);
    if (existing === undefined) entries.push({ label: route.navGroup, path: route.path, routes: [route] });
    else existing.routes.push(route);
  }
  return entries;
}

/** Every route the palette lists for this role. */
export function paletteRoutes(isAdmin: boolean): AppRoute[] {
  return ROUTES.filter((route) => route.palette && (!route.adminOnly || isAdmin));
}
