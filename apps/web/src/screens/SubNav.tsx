// A nav entry with several screens (Security & devices) gets a row of links between them. PST-T-14.11:
// each of those screens draws it under its own PageHeader — the page's title first, then where you
// can go beside it — rather than the shell drawing it above the title.
import { useContext } from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { PaletteRoleContext } from '../mail/CommandPalette';
import { navEntries, routeForPath } from '../routes';

export function SubNav() {
  const location = useLocation();
  const isAdmin = useContext(PaletteRoleContext);
  const route = routeForPath(location.pathname);
  if (route === null || route.navGroup === undefined || route.place === 'mail') return null;
  const entry = navEntries(route.place, isAdmin).find((e) => e.label === route.navGroup);
  if (entry === undefined || entry.routes.length < 2) return null;
  return (
    <nav aria-label={entry.label}>
      <ul className="pr-subnav" role="list">
        {entry.routes.map((r) => (
          <li key={r.id}>
            <RouterLink to={r.path} {...(r === route ? { 'aria-current': 'page' as const } : {})}>
              {r.title}
            </RouterLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
