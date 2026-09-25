import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavGroup,
  SideNavItem,
  ThemeSwitch,
} from '@d3cloud/ui';
import { api, type AuthState } from '../api';

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

/** The signed-in frame: sidebar (a drawer below `lg`), the account menu, and the page. */
export function Shell({ state, onSignedOut }: { state: AuthState; onSignedOut: () => Promise<void> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const account = state.account;

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
          <SideNavGroup title="Mail" hideTitle>
            <SideNavItem asChild icon={<MailIcon />} label="Mail" current={location.pathname === '/'}>
              <RouterLink to="/" />
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
