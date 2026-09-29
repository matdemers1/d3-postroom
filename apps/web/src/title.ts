// The document title (PST-DA-043): 'Postroom' on every route said nothing about where you were —
// the tab bar, browser history and screen readers all lost the screen name. Since PST-T-14.3 the
// name comes from the route table (routes.ts), the same place both navs and the palette read it.
import { routeForPath } from './routes';

export function appTitle(): string {
  return 'Postroom';
}

/** '<Screen> — Postroom' for a known route, or plain 'Postroom' (e.g. an unmatched path that
 * App.tsx redirects away from anyway). */
export function titleForPath(pathname: string): string {
  const route = routeForPath(pathname);
  return route === null ? appTitle() : `${route.title} — ${appTitle()}`;
}
