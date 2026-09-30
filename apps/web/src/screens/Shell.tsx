// The signed-in frame (PST-T-14.3, PST-REQ-189, PST-ADR-011): three places, one frame. Mail's
// sidebar holds mailboxes and the Calendar and Contacts places only; Settings and the Admin console
// are reached from the account menu and each has its own left nav with "Back to Mail". Every nav
// entry comes from the route table (routes.ts). Places swap with a cross-fade (--dur-2), never a
// slide (D-024), and each pane sits in an error boundary so one failure never blanks the app.
import '../styles/places.css';
import '../styles/fields.css';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  Button,
  MenuItem,
  MenuSeparator,
  Page,
  PageHeader,
  SideNav,
  SideNavGroup,
  SideNavItem,
  ThemeSwitch,
  useAppShell,
} from '@d3cloud/ui';
import { api, WIZARD_CHANGED_EVENT, wizardStepsLeft, type AuthState, type Mailbox } from '../api';
import { CommandPalette, PaletteRoleContext } from '../mail/CommandPalette';
import { findSpecial, mailboxLabel } from '../mail/format';
import { ComposeIcon, mailboxIcon } from '../mail/icons';
import { resolveKey } from '../mail/keys';
import { useOptionalMail } from '../mail/MailContext';
import { mailPath, parseMailRoute } from '../mail/route';
import { LAST_VISIT_KEY, mailSidebar, newSinceVisit, parseVisits, type LastVisits } from '../mail/sidebar';
import { SPLIT_QUERY, WIDE_QUERY, useMediaQuery } from '../mail/useMedia';
import { ContextBar, PushFrame, usePushDirection } from '../mobile/ContextBar';
import { PhoneAccountMenu, PlaceIndex } from '../mobile/PlaceIndex';
import { contextParent, contextTitle, placeIndexFor, pushDepth } from '../mobile/push';
import { navEntries, PLACE_HOME, PLACE_NAME, routeForPath, type Place } from '../routes';
import { PaneBoundary } from './PaneBoundary';
import { NoAccess } from './states';

// Decorative marks, drawn in currentColor so they follow the theme.
function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function SessionsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="4" y="4" width="16" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l3 3M15 8l2 2" />
    </svg>
  );
}

function MaskIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M4 10c2-3 6-4 8-4s6 1 8 4c0 5-3 9-8 9s-8-4-8-9Z" />
      <circle cx="9" cy="11" r="1" />
      <circle cx="15" cy="11" r="1" />
    </svg>
  );
}

function HeartbeatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  );
}

function OutboxIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 3v11M12 3l-4 4M12 3l4 4" />
      <path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

function BlockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 6.5l11 11" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </svg>
  );
}

function QueueIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="4" y="5" width="16" height="4" rx="1" />
      <rect x="4" y="10" width="16" height="4" rx="1" />
      <rect x="4" y="15" width="16" height="4" rx="1" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 3v11M8 10l4 4 4-4" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

function SetupIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M4 6h16M4 12h10M4 18h6" />
      <path d="m15 17 2 2 4-4" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M4 5h16l-6 7v6l-4 2v-8z" />
    </svg>
  );
}

function TemplatesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M6 4h9l4 4v12H6z" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}

function ContactsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5" />
    </svg>
  );
}

function SealIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </svg>
  );
}

/** Each left-nav entry's mark, by its label in the route table. */
const NAV_ICONS: Readonly<Record<string, () => ReactNode>> = {
  Calendar: CalendarIcon,
  'Admin console': HeartbeatIcon,
  Contacts: ContactsIcon,
  Account: PersonIcon,
  'Security & devices': LockIcon,
  Addresses: MaskIcon,
  'Rules & sorting': FilterIcon,
  Templates: TemplatesIcon,
  'Import & export': ImportIcon,
  'Encryption keys': SealIcon,
  Health: HeartbeatIcon,
  'Outbound queue': OutboxIcon,
  Deliverability: ChartIcon,
  'DNS & DKIM': GlobeIcon,
  'Live SMTP': TerminalIcon,
  Jobs: QueueIcon,
  'Sign-in sessions': SessionsIcon,
  Suppressions: BlockIcon,
  Setup: SetupIcon,
};

function navIcon(label: string) {
  const Icon = NAV_ICONS[label] ?? KeyIcon;
  return <Icon />;
}

/** Steps of the setup wizard (PST-T-4.8) still to do, for an admin; re-read when `pathname` changes (the caller passes '/' outside admin pages, so reading mail never refetches it). */
function useSetupStepsLeft(isAdmin: boolean, pathname: string): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!isAdmin) return undefined;
    const refresh = (): void => {
      api
        .wizard()
        .then((v) => {
          setLeft(wizardStepsLeft(v));
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener(WIZARD_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(WIZARD_CHANGED_EVENT, refresh);
    };
  }, [isAdmin, pathname]);
  return left;
}


/** Where "Back to Mail" returns: the last mail URL this tab showed (a mailbox, an open message). */
let lastMailPath = '/';

/** PST-T-14.8: the last URL of the mail view itself (not Calendar or Contacts) — where a phone's
 * sender profile goes Back to. */
let lastMailViewPath = '/';

/** The place on screen before this render — so arriving in a place from another one cross-fades,
 * while a page load (nothing was on screen) simply appears. */
let shownPlace: Place | null = null;

/** Whether this mount is a move between places: decided once, when the keyed nav or frame mounts. */
function usePlaceFade(place: Place): boolean {
  const [fade] = useState(() => shownPlace !== null && shownPlace !== place);
  useEffect(() => {
    shownPlace = place;
  }, [place]);
  return fade;
}

function PlaceFrame({ place, phone, children }: { place: Place; phone: boolean; children: ReactNode }) {
  // On a phone a move between places is a push like any other (PST-T-14.8), not a cross-fade.
  const fade = usePlaceFade(place) && !phone;
  return (
    <div className={fade ? 'pr-place pr-place--fade' : 'pr-place'} data-place={place}>
      {children}
    </div>
  );
}

function readVisits(): LastVisits {
  try {
    return parseVisits(window.localStorage.getItem(LAST_VISIT_KEY));
  } catch {
    return {};
  }
}

/** Junk and Rejects remember what you had seen there, so their count is "new since your last visit". */
function useLastVisits(watched: readonly Mailbox[], currentMailbox: string | null): LastVisits {
  const [visits, setVisits] = useState<LastVisits>(readVisits);
  const current = watched.find((m) => m.id === currentMailbox);
  const currentId = current?.id;
  const currentUidnext = current?.uidnext;
  useEffect(() => {
    if (currentId === undefined || currentUidnext === undefined) return;
    setVisits((prev) => {
      if (prev[currentId] === currentUidnext) return prev;
      const next = { ...prev, [currentId]: currentUidnext };
      try {
        window.localStorage.setItem(LAST_VISIT_KEY, JSON.stringify(next));
      } catch {
        // Private mode: the count is simply this session's.
      }
      return next;
    });
  }, [currentId, currentUidnext]);
  return visits;
}

function MoreFolders({ mailboxes, currentMailbox }: { mailboxes: readonly Mailbox[]; currentMailbox: string | null }) {
  const { collapsed } = useAppShell();
  const holdsCurrent = mailboxes.some((m) => m.id === currentMailbox);
  const [open, setOpen] = useState(holdsCurrent);
  useEffect(() => {
    if (holdsCurrent) setOpen(true);
  }, [holdsCurrent]);
  const unseen = mailboxes.reduce((n, m) => n + (m.specialUse === 'trash' ? 0 : m.unseen), 0);
  return (
    <SideNavGroup title="More" hideTitle className="pr-nav-quiet">
      <li className="d3-snav__li">
        <button
          type="button"
          className="d3-snav__item pr-nav-more"
          aria-expanded={open}
          aria-controls="pr-nav-more-list"
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          <span className="d3-snav__icon pr-nav-more__chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
          <span className={collapsed ? 'd3-snav__label d3-snav__vh' : 'd3-snav__label'}>More</span>
          {collapsed ? null : <span className="pr-nav-more__detail">{unseen > 0 ? `${String(unseen)} unread` : 'Trash, folders'}</span>}
        </button>
        <ul id="pr-nav-more-list" role="list" className="d3-snav__list pr-nav-more__list" hidden={!open}>
          {mailboxes.map((m) => (
            <MailboxItem key={m.id} mailbox={m} current={currentMailbox === m.id} count={m.specialUse === 'trash' ? 0 : m.unseen} countNoun="unread" />
          ))}
        </ul>
      </li>
    </SideNavGroup>
  );
}

function MailboxItem({ mailbox, current, count, countNoun }: { mailbox: Mailbox; current: boolean; count: number; countNoun: string }) {
  const label = mailboxLabel(mailbox);
  return (
    <SideNavItem
      asChild
      icon={mailboxIcon(mailbox.specialUse, mailbox.name)}
      label={label}
      current={current}
      {...(count > 0 ? { count, countLabel: `${label}, ${String(count)} ${countNoun}` } : {})}
    >
      <RouterLink to={mailPath(mailbox.id)} />
    </SideNavItem>
  );
}

/** Mail's sidebar: mailboxes, then the Calendar and Contacts places. Nothing else. */
function MailNav({ isAdmin }: { isAdmin: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const mail = useOptionalMail();
  const wide = useMediaQuery(WIDE_QUERY);
  const mailRoute = parseMailRoute(location.pathname, location.search);
  const mailboxes = mail?.mailboxes ?? null;
  const inbox = mailboxes === null ? undefined : findSpecial(mailboxes, 'inbox');
  // '/' is the inbox; '/mail' (the push-nav mailbox list) is no mailbox in particular.
  const currentMailbox = mailRoute === null ? null : (mailRoute.mailboxId ?? (mailRoute.mailboxIndex ? null : (inbox?.id ?? null)));
  const groups = mailboxes === null ? null : mailSidebar(mailboxes);
  const visits = useLastVisits(groups?.safetyNet ?? [], currentMailbox);
  const places = navEntries('mail', isAdmin);
  const route = routeForPath(location.pathname);
  const fade = usePlaceFade('mail');

  return (
    <SideNav aria-label="Main" {...(fade ? { className: 'pr-place--fade' } : {})}>
      {wide && mail !== null ? (
        <li className="pr-nav-compose">
          <Button
            variant="primary"
            icon={<ComposeIcon />}
            onClick={() => {
              void navigate(mailPath(mailRoute?.mailboxId ?? null, mailRoute?.messageId ?? null, 'new'));
            }}
          >
            New message
          </Button>
        </li>
      ) : null}
      {groups === null ? (
        <SideNavGroup title="Mailboxes" hideTitle>
          <SideNavItem asChild icon={<MailIcon />} label="Mail" current={mailRoute !== null}>
            <RouterLink to="/" />
          </SideNavItem>
        </SideNavGroup>
      ) : (
        <>
          <SideNavGroup title="Mailboxes" hideTitle>
            {groups.primary.map((m) => (
              <MailboxItem key={m.id} mailbox={m} current={currentMailbox === m.id} count={m.id === inbox?.id ? m.unseen : 0} countNoun="unread" />
            ))}
          </SideNavGroup>
          {groups.sorted.length > 0 ? (
            <SideNavGroup title="Sorted for you" className="pr-nav-quiet">
              {groups.sorted.map((m) => (
                <MailboxItem key={m.id} mailbox={m} current={currentMailbox === m.id} count={m.unseen} countNoun="unread" />
              ))}
            </SideNavGroup>
          ) : null}
          {groups.safetyNet.length > 0 ? (
            // The sorter's safety net: one click away, and a quiet count of what is new since you
            // last looked — never a loud pill for mail you meant not to see.
            <SideNavGroup title="Filtered out" className="pr-nav-quiet">
              {groups.safetyNet.map((m) => (
                <MailboxItem key={m.id} mailbox={m} current={currentMailbox === m.id} count={newSinceVisit(m, visits)} countNoun="new since your last visit" />
              ))}
            </SideNavGroup>
          ) : null}
          {groups.more.length > 0 ? <MoreFolders mailboxes={groups.more} currentMailbox={currentMailbox} /> : null}
        </>
      )}
      <SideNavGroup title="Places" hideTitle>
        {places.map((entry) => (
          <SideNavItem
            key={entry.label}
            asChild
            icon={navIcon(entry.label)}
            label={entry.label}
            current={route !== null && entry.routes.includes(route)}
          >
            <RouterLink to={entry.path} />
          </SideNavItem>
        ))}
      </SideNavGroup>
    </SideNav>
  );
}

/** Settings' or the Admin console's own left nav, with the way back to Mail first. */
function PlaceNav({ place, isAdmin, setupLeft }: { place: 'settings' | 'admin'; isAdmin: boolean; setupLeft: number }) {
  const location = useLocation();
  const route = routeForPath(location.pathname);
  const name = PLACE_NAME[place];
  const fade = usePlaceFade(place);
  return (
    <SideNav aria-label={name} className={[place === 'admin' ? 'pr-nav-admin' : '', fade ? 'pr-place--fade' : ''].filter((c) => c !== '').join(' ')}>
      <SideNavItem asChild icon={<BackIcon />} label="Back to Mail">
        <RouterLink to={lastMailPath} />
      </SideNavItem>
      <SideNavGroup title={name}>
        {navEntries(place, isAdmin).map((entry) => {
          const count = entry.label === 'Setup' ? setupLeft : 0;
          return (
            <SideNavItem
              key={entry.label}
              asChild
              icon={navIcon(entry.label)}
              label={entry.label}
              current={route !== null && entry.routes.includes(route)}
              {...(count > 0 ? { count, countLabel: `Setup, ${String(count)} ${count === 1 ? 'step' : 'steps'} left` } : {})}
            >
              <RouterLink to={entry.path} />
            </SideNavItem>
          );
        })}
      </SideNavGroup>
    </SideNav>
  );
}

/** ⌘K outside Mail: MailView owns the palette in Mail (with message actions); Settings and the
 * Admin console get the same palette, with places only. */
function PlacePalette({ enabled }: { enabled: boolean }) {
  const navigate = useNavigate();
  const mail = useOptionalMail();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      const { action } = resolveKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, editable: false, activatable: false }, null);
      if (action !== 'commandPalette') return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
  const onNavigate = useCallback(
    (path: string) => {
      void navigate(path);
    },
    [navigate],
  );
  if (!enabled) return null;
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      mailboxes={mail?.mailboxes ?? null}
      target={null}
      onMove={() => undefined}
      onNavigate={onNavigate}
    />
  );
}

/** The signed-in frame: the place's nav (a drawer below `lg`), the account menu, and the page. */
export function Shell({ state, onSignedOut }: { state: AuthState; onSignedOut: () => Promise<void> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const mail = useOptionalMail();
  const account = state.account;
  const isAdmin = account?.isAdmin === true;
  // PST-T-14.8: below 768 px the app is one push stack — no drawer; '/settings' and '/admin' are
  // the places' own index screens (on a wider screen they redirect to the place's first screen).
  const phone = !useMediaQuery(SPLIT_QUERY);
  const phoneIndex = phone ? placeIndexFor(location.pathname) : null;
  const route = routeForPath(location.pathname);
  const place: Place = phoneIndex ?? route?.place ?? 'mail';
  const isMailView = phoneIndex === null && (route === null || route.id === 'mail' || route.id === 'mailFolder');
  // A non-admin in /admin/* sees the no-access state beside Mail's nav, never the admin nav.
  const navPlace = place === 'admin' && !isAdmin ? 'mail' : place;
  const setupLeft = useSetupStepsLeft(isAdmin, place === 'admin' ? location.pathname : '/');
  // One push screen per nav entry, not per URL: the screens under one entry (Contacts' list, new
  // and card; Security & devices' three) are one component that carries state across its own URLs
  // (a "Contact added." notice), so a move between them must not remount it.
  const pushScreen = isMailView ? 'mail' : phoneIndex !== null ? `index:${phoneIndex}` : route?.navGroup !== undefined ? `${route.place}:${route.navGroup}` : location.pathname;
  const direction = usePushDirection(pushScreen, pushDepth(location.pathname, location.search));

  if (place === 'mail' && phoneIndex === null) lastMailPath = location.pathname + location.search;
  if (isMailView) lastMailViewPath = location.pathname + location.search;

  const signOut = () => {
    api
      .signOut()
      .catch(() => undefined)
      .finally(() => {
        void onSignedOut().then(() => navigate('/signin', { replace: true }));
      });
  };

  // On a phone the account menu lives on the root screens (Mailboxes, Settings), and its places
  // open at their index screens, since there is no left nav to choose from.
  const accountMenu = (
    <AccountMenu name={account?.displayName ?? 'Account'} {...(account?.address ? { detail: account.address } : {})}>
      <MenuItem asChild>
        <RouterLink to={phone ? '/settings' : PLACE_HOME.settings}>Settings</RouterLink>
      </MenuItem>
      {isAdmin ? (
        <MenuItem asChild>
          <RouterLink to={phone ? '/admin' : PLACE_HOME.admin}>{setupLeft > 0 ? `Admin console (${String(setupLeft)} setup ${setupLeft === 1 ? 'step' : 'steps'} left)` : 'Admin console'}</RouterLink>
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <ThemeSwitch label="Theme" />
      <MenuSeparator />
      <MenuItem tone="danger" onSelect={signOut}>
        Sign out
      </MenuItem>
    </AccountMenu>
  );

  let page: ReactNode;
  if (phoneIndex !== null) {
    page = phoneIndex === 'admin' && !isAdmin ? (
      <Page>
        <PageHeader title="Admin" />
        <NoAccess />
      </Page>
    ) : (
      <PlaceIndex place={phoneIndex} isAdmin={isAdmin} setupLeft={setupLeft} iconFor={navIcon} account={accountMenu} />
    );
  } else if (place === 'admin' && !isAdmin) {
    // PST-T-11.1: the server refuses every /api/admin call to a non-admin (403); the screen says so
    // itself rather than leaving each admin page to fail its own way.
    page = (
      <Page>
        <PageHeader title="Admin" />
        <NoAccess />
      </Page>
    );
  } else {
    page = <Outlet />;
  }

  let frame: ReactNode = (
    <>
      <PaneBoundary name="This page" resetKey={location.pathname}>
        {page}
      </PaneBoundary>
    </>
  );
  if (phone) {
    // The mail view draws its own bars (it knows the mailbox and has Search and Compose to offer);
    // every other screen gets Back with its parent's name, and its title.
    const lastMail = parseMailRoute(lastMailViewPath.split('?')[0] ?? '/', '');
    const lastBox = lastMail?.mailboxId === null || lastMail === null ? null : (mail?.mailboxes?.find((m) => m.id === lastMail.mailboxId) ?? null);
    const lastMailName = lastMail?.mailboxIndex === true ? 'Mailboxes' : lastBox === null ? 'Inbox' : mailboxLabel(lastBox);
    frame = (
      <PushFrame key={pushScreen} direction={direction} className={isMailView ? 'pr-push--mail' : undefined}>
        {isMailView ? null : <ContextBar back={contextParent(location.pathname, lastMailViewPath, lastMailName)} title={contextTitle(location.pathname)} />}
        {frame}
        {/* With no drawer, a Settings or Admin screen keeps the account menu (theme, Sign out) at its
            foot, so signing out never means leaving the page first. */}
        {phoneIndex === null && (place === 'settings' || place === 'admin') ? <div className="pr-place-account">{accountMenu}</div> : null}
      </PushFrame>
    );
  }

  return (
    <PhoneAccountMenu.Provider value={phone ? accountMenu : null}>
    <PaletteRoleContext.Provider value={isAdmin}>
      <AppShell
        navTone="recessed"
        storageKey="postroom-shell"
        brand={
          <AppShellBrand asChild name="Postroom" mark={<MailIcon />}>
            <RouterLink to="/" />
          </AppShellBrand>
        }
        nav={
          <PaneBoundary name="Navigation" resetKey={location.pathname}>
            {navPlace === 'settings' || navPlace === 'admin' ? (
              <PlaceNav key={navPlace} place={navPlace} isAdmin={isAdmin} setupLeft={setupLeft} />
            ) : (
              <MailNav key="mail" isAdmin={isAdmin} />
            )}
          </PaneBoundary>
        }
        footer={accountMenu}
      >
        <PlaceFrame key={place} place={place} phone={phone}>
          {frame}
        </PlaceFrame>
        <PlacePalette enabled={place !== 'mail'} />
      </AppShell>
    </PaletteRoleContext.Provider>
    </PhoneAccountMenu.Provider>
  );
}
