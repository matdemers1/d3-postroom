import { useEffect, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  Button,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavGroup,
  SideNavItem,
  ThemeSwitch,
} from '@d3cloud/ui';
import { api, WIZARD_CHANGED_EVENT, wizardStepsLeft, type AuthState } from '../api';
import { findSpecial, mailboxLabel } from '../mail/format';
import { ComposeIcon, mailboxIcon } from '../mail/icons';
import { useOptionalMail } from '../mail/MailContext';
import { mailPath, parseMailRoute } from '../mail/route';
import { WIDE_QUERY, useMediaQuery } from '../mail/useMedia';

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

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
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
  const setupLeft = useSetupStepsLeft(account?.isAdmin === true, location.pathname.startsWith('/admin') ? location.pathname : '/');
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
          <SideNavGroup title="Account">
            <SideNavItem asChild icon={<KeyIcon />} label="App passwords" current={location.pathname === '/app-passwords'}>
              <RouterLink to="/app-passwords" />
            </SideNavItem>
            <SideNavItem asChild icon={<LockIcon />} label="Change password" current={location.pathname === '/account/password'}>
              <RouterLink to="/account/password" />
            </SideNavItem>
            <SideNavItem asChild icon={<SessionsIcon />} label="Devices" current={location.pathname === '/account/sessions'}>
              <RouterLink to="/account/sessions" />
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
              <SideNavItem
                asChild
                icon={<SetupIcon />}
                label="Setup"
                current={location.pathname === '/admin/setup'}
                {...(setupLeft > 0 ? { count: setupLeft, countLabel: `Setup, ${String(setupLeft)} ${setupLeft === 1 ? 'step' : 'steps'} left` } : {})}
              >
                <RouterLink to="/admin/setup" />
              </SideNavItem>
              <SideNavItem asChild icon={<GlobeIcon />} label="DNS records" current={location.pathname === '/admin/dns'}>
                <RouterLink to="/admin/dns" />
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
      <Outlet />
    </AppShell>
  );
}
