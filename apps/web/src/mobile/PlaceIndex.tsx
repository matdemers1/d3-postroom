// PST-T-14.8 (PST-REQ-155, PST-ADR-011; design audit IA-14, RSP-04): on a phone there is no
// hamburger drawer. Settings and the Admin console are push levels like the mailboxes: '/settings'
// and '/admin' show the place's screens as rows (from the route table, like the desktop's left
// nav), and a row pushes its screen. The account menu (theme, Sign out) sits at the foot.
import { createContext, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { navEntries, PLACE_NAME } from '../routes';
import type { PlaceIndex as PlaceIndexName } from './push';

/** The account menu, drawn by Shell (it owns Sign out), for a phone's root screens to show. */
export const PhoneAccountMenu = createContext<ReactNode>(null);

function RowChevron() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** One push row: icon, name, an optional count, and the chevron that says it goes deeper. */
export function PushRow({ to, icon, label, count, countLabel }: { to: string; icon: ReactNode; label: string; count?: number; countLabel?: string }) {
  const counted = count !== undefined && count > 0;
  return (
    <li>
      <RouterLink className="pr-prow" to={to} {...(counted && countLabel !== undefined ? { 'aria-label': countLabel } : {})}>
        <span className="pr-prow__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="pr-prow__label">{label}</span>
        {counted ? (
          <span className="pr-prow__count" aria-hidden="true">
            {count}
          </span>
        ) : null}
        <span className="pr-prow__chevron" aria-hidden="true">
          <RowChevron />
        </span>
      </RouterLink>
    </li>
  );
}

export function PlaceIndex({
  place,
  isAdmin,
  setupLeft,
  iconFor,
  account,
}: {
  place: PlaceIndexName;
  isAdmin: boolean;
  setupLeft: number;
  iconFor: (label: string) => ReactNode;
  account: ReactNode;
}) {
  const name = PLACE_NAME[place];
  return (
    <section className="pr-pindex" aria-labelledby="pr-pindex-title">
      <h1 id="pr-pindex-title" className="pr-vh">
        {name}
      </h1>
      <nav aria-label={name}>
        <ul className="pr-prows" role="list">
          {navEntries(place, isAdmin).map((entry) => {
            const count = entry.label === 'Setup' ? setupLeft : 0;
            return (
              <PushRow
                key={entry.label}
                to={entry.path}
                icon={iconFor(entry.label)}
                label={entry.label}
                count={count}
                countLabel={`Setup, ${String(count)} ${count === 1 ? 'step' : 'steps'} left`}
              />
            );
          })}
        </ul>
      </nav>
      {place === 'settings' && isAdmin ? (
        <nav aria-label="More places">
          <ul className="pr-prows" role="list">
            <PushRow
              to="/admin"
              icon={iconFor('Admin console')}
              label={PLACE_NAME.admin}
              count={setupLeft}
              countLabel={`Admin console, ${String(setupLeft)} setup ${setupLeft === 1 ? 'step' : 'steps'} left`}
            />
          </ul>
        </nav>
      ) : null}
      <div className="pr-pindex__account">{account}</div>
    </section>
  );
}
