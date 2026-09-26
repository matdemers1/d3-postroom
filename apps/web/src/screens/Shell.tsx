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
} from '@d3cloud/ui';
import { api, type AuthState } from '../api';
import { findSpecial, mailboxLabel } from '../mail/format';
import { ComposeIcon, mailboxIcon } from '../mail/icons';
import { useOptionalMail } from '../mail/MailContext';
import { mailPath, parseMailRoute } from '../mail/route';
import { WIDE_QUERY, useMediaQuery } from '../mail/useMedia';
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

function DeviceSetupIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
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

/** The signed-in frame: sidebar (a drawer below `lg`), the account menu, and the page. */
export function Shell({ state, onSignedOut }: { state: AuthState; onSignedOut: () => Promise<void> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const account = state.account;
  const mail = useOptionalMail();
  const wide = useMediaQuery(WIDE_QUERY);
  const mailRoute = parseMailRoute(location.pathname, location.search);
  const inbox = mail?.mailboxes === null || mail === null ? undefined : findSpecial(mail.mailboxes, 'inbox');
  // '/' is the inbox; '/mail' (the push-nav mailbox list) is no mailbox in particular.
  const currentMailbox = mailRoute === null ? null : (mailRoute.mailboxId ?? (mailRoute.mailboxIndex ? null : (inbox?.id ?? null)));

  const signOut = () => {
    api
      .signOut()
      .catch(() => undefined)
      .finally(() => {
        void onSignedOut().then(() => navigate('/signin', { replace: true }));
      });
  };

  return (
    <AppShell
      storageKey="postroom-shell"
      brand={
        <AppShellBrand asChild name="Postroom" mark={<MailIcon />}>
          <RouterLink to="/" />
        </AppShellBrand>
      }
      nav={
        <SideNav aria-label="Main">
          {wide && mail !== null ? (
            <li className="pr-nav-compose">
              <Button
                variant="primary"
                icon={<ComposeIcon />}
                onClick={() => {
                  void navigate(mailPath(mailRoute?.mailboxId ?? null, mailRoute?.messageId ?? null, 'new'));
                }}
              >
                Compose
              </Button>
            </li>
          ) : null}
          <SideNavGroup title="Mailboxes">
            {mail?.mailboxes === null || mail === null ? (
              <SideNavItem asChild icon={<MailIcon />} label="Mail" current={mailRoute !== null}>
                <RouterLink to="/" />
              </SideNavItem>
            ) : (
              mail.mailboxes.map((m) => (
                <SideNavItem
                  key={m.id}
                  asChild
                  icon={mailboxIcon(m.specialUse, m.name)}
                  label={mailboxLabel(m)}
                  current={currentMailbox === m.id}
                  {...(m.unseen > 0 ? { count: m.unseen, countLabel: `${mailboxLabel(m)}, ${String(m.unseen)} unread` } : {})}
                >
                  <RouterLink to={mailPath(m.id)} />
                </SideNavItem>
              ))
            )}
          </SideNavGroup>
          <SideNavGroup title="Organise">
            <SideNavItem asChild icon={<CalendarIcon />} label="Calendar" current={location.pathname === '/calendar'}>
              <RouterLink to="/calendar" />
            </SideNavItem>
            <SideNavItem asChild icon={<ContactsIcon />} label="Contacts" current={location.pathname.startsWith('/contacts')}>
              <RouterLink to="/contacts" />
            </SideNavItem>
          </SideNavGroup>
          <SideNavGroup title="Account">
            <SideNavItem asChild icon={<KeyIcon />} label="App passwords" current={location.pathname === '/app-passwords'}>
              <RouterLink to="/app-passwords" />
            </SideNavItem>
            <SideNavItem asChild icon={<MaskIcon />} label="Masked aliases" current={location.pathname === '/account/aliases'}>
              <RouterLink to="/account/aliases" />
            </SideNavItem>
            <SideNavItem asChild icon={<LockIcon />} label="Change password" current={location.pathname === '/account/password'}>
              <RouterLink to="/account/password" />
            </SideNavItem>
            <SideNavItem asChild icon={<SessionsIcon />} label="Devices" current={location.pathname === '/account/sessions'}>
              <RouterLink to="/account/sessions" />
            </SideNavItem>
            <SideNavItem asChild icon={<ImportIcon />} label="Import mail" current={location.pathname === '/account/import'}>
              <RouterLink to="/account/import" />
            </SideNavItem>
            <SideNavItem asChild icon={<DeviceSetupIcon />} label="Set up iPhone / Mac" current={location.pathname === '/account/device-setup'}>
              <RouterLink to="/account/device-setup" />
            </SideNavItem>
            <SideNavItem asChild icon={<FilterIcon />} label="Rules" current={location.pathname === '/account/rules'}>
              <RouterLink to="/account/rules" />
            </SideNavItem>
            <SideNavItem asChild icon={<TemplatesIcon />} label="Compose templates" current={location.pathname === '/account/templates'}>
              <RouterLink to="/account/templates" />
            </SideNavItem>
          </SideNavGroup>
          {account?.isAdmin === true ? (
            <SideNavGroup title="Admin">
              <SideNavItem
                asChild
                icon={<SessionsIcon />}
                label="Sessions"
                current={location.pathname === '/admin/sessions'}
              >
                <RouterLink to="/admin/sessions" />
              </SideNavItem>
              <SideNavItem asChild icon={<HeartbeatIcon />} label="Health" current={location.pathname === '/admin/health'}>
                <RouterLink to="/admin/health" />
              </SideNavItem>
              <SideNavItem asChild icon={<QueueIcon />} label="Jobs" current={location.pathname === '/admin/jobs'}>
                <RouterLink to="/admin/jobs" />
              </SideNavItem>
              <SideNavItem asChild icon={<OutboxIcon />} label="Outbound queue" current={location.pathname === '/admin/queue'}>
                <RouterLink to="/admin/queue" />
              </SideNavItem>
              <SideNavItem asChild icon={<ChartIcon />} label="Deliverability" current={location.pathname === '/admin/deliverability'}>
                <RouterLink to="/admin/deliverability" />
              </SideNavItem>
              <SideNavItem asChild icon={<TerminalIcon />} label="SMTP sessions" current={location.pathname === '/admin/smtp'}>
                <RouterLink to="/admin/smtp" />
              </SideNavItem>
            </SideNavGroup>
          ) : null}
        </SideNav>
      }
      footer={
        <AccountMenu name={account?.displayName ?? 'Account'} {...(account?.address ? { detail: account.address } : {})}>
          <ThemeSwitch label="Theme" />
          <MenuSeparator />
          <MenuItem tone="danger" onSelect={signOut}>
            Sign out
          </MenuItem>
        </AccountMenu>
      }
    >
      {/* PST-T-11.1: the server refuses every /api/admin call to a non-admin (403); the screen says
          so itself rather than leaving each admin page to fail its own way. */}
      {location.pathname.startsWith('/admin/') && account?.isAdmin !== true ? (
        <Page>
          <PageHeader title="Admin" />
          <NoAccess />
        </Page>
      ) : (
        <Outlet />
      )}
    </AppShell>
  );
}
