// A nav entry with several screens (Security & devices) gets a row of links between them. PST-T-14.11:
// each of those screens draws it under its own PageHeader — the page's title first, then where you
// can go beside it — rather than the shell drawing it above the title. PST-T-17.9: an underline tab
// bar (security.css) that never wraps, still a <nav> of links with aria-current on the current page,
// because each tab is its own route.
import { useCallback, useContext } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { PaletteRoleContext } from '../mail/CommandPalette';
import { navEntries, routeForPath } from '../routes';
import './device/security.css';

export function SubNav() {
  const location = useLocation();
  const isAdmin = useContext(PaletteRoleContext);
  const route = routeForPath(location.pathname);
  // On a phone the row scrolls sideways: bring the current tab into view rather than leave it cut
  // off at the edge (the last tab is the one that overflows at 390px).
  const reveal = useCallback((el: HTMLAnchorElement | null) => {
    if (el !== null && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);
  if (route === null || route.navGroup === undefined || route.place === 'mail') return null;
  const entry = navEntries(route.place, isAdmin).find((e) => e.label === route.navGroup);
  if (entry === undefined || entry.routes.length < 2) return null;
  return (
    <nav aria-label={entry.label} className="pr-sectabs">
      <ul className="pr-sectabs__list" role="list">
        {entry.routes.map((r) => (
          <li key={r.id}>
            <RouterLink className="pr-sectabs__link" to={r.path} {...(r === route ? { 'aria-current': 'page' as const, ref: reveal } : {})}>
              {r.title}
            </RouterLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
