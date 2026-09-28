// The document title (PST-DA-043): 'Postroom' on every route said nothing about where you were —
// the tab bar, browser history and screen readers all lost the screen name. `titleForPath` mirrors
// App.tsx's routes; kept here, pure, so it is unit-tested without pulling in @d3cloud/ui's CSS.
export function appTitle(): string {
  return 'Postroom';
}

const ROUTE_NAMES: { test: (pathname: string) => boolean; name: string }[] = [
  { test: (p) => p === '/setup', name: 'Setup' },
  { test: (p) => p === '/signin', name: 'Sign in' },
  { test: (p) => p === '/calendar', name: 'Calendar' },
  { test: (p) => p.startsWith('/contacts'), name: 'Contacts' },
  { test: (p) => p.startsWith('/senders/'), name: 'Sender' },
  { test: (p) => p === '/app-passwords', name: 'App passwords' },
  { test: (p) => p === '/account/aliases', name: 'Masked aliases' },
  { test: (p) => p === '/account/password', name: 'Change password' },
  { test: (p) => p === '/account/sessions', name: 'Devices' },
  { test: (p) => p === '/account/import', name: 'Import mail' },
  { test: (p) => p === '/account/device-setup', name: 'Set up iPhone / Mac' },
  { test: (p) => p === '/account/rules', name: 'Rules' },
  { test: (p) => p === '/account/templates', name: 'Compose templates' },
  { test: (p) => p === '/account/keys', name: 'Keys' },
  { test: (p) => p === '/admin/sessions', name: 'Sessions' },
  { test: (p) => p === '/admin/health', name: 'Health' },
  { test: (p) => p === '/admin/jobs', name: 'Jobs' },
  { test: (p) => p === '/admin/queue', name: 'Outbound queue' },
  { test: (p) => p === '/admin/suppressions', name: 'Suppression list' },
  { test: (p) => p === '/admin/deliverability', name: 'Deliverability' },
  { test: (p) => p === '/admin/smtp', name: 'SMTP sessions' },
  { test: (p) => p === '/admin/setup', name: 'Setup wizard' },
  { test: (p) => p === '/admin/dns', name: 'DNS' },
  { test: (p) => p === '/' || p.startsWith('/mail'), name: 'Mail' },
];

/** '<Screen> — Postroom' for a known route, or plain 'Postroom' (e.g. an unmatched path that
 * App.tsx redirects away from anyway). */
export function titleForPath(pathname: string): string {
  const route = ROUTE_NAMES.find((r) => r.test(pathname));
  return route === undefined ? appTitle() : `${route.name} — ${appTitle()}`;
}
