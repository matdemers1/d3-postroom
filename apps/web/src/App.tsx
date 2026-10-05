import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Alert, Button, Spinner, ThemeProvider, ToastRegion } from '@d3cloud/ui';
import { api, redirectFor, serverUnreachable, type AuthState } from './api';
import { EntryHeading, EntryShell } from './entry/EntryShell';
import { MAIL_HOME, REDIRECTS, ROUTES, type RouteId } from './routes';
import { titleForPath } from './title';
import { Calendar } from './calendar/Calendar';
import { Contacts } from './contacts/Contacts';
import { Keys } from './keys/Keys';
import { MailProvider } from './mail/MailContext';
import { TemplatesScreen } from './compose/TemplatesScreen';
import { AccountScreen } from './screens/ChangePassword';
import { AdminDeliverability } from './screens/AdminDeliverability';
import { AdminHealth } from './screens/AdminHealth';
import { AdminJobs } from './screens/AdminJobs';
import { AdminQueue } from './screens/AdminQueue';
import { AdminSuppressions } from './screens/AdminSuppressions';
import { AdminDns } from './screens/AdminDns';
import { AdminSessions } from './screens/AdminSessions';
import { AdminSmtpViewer } from './admin/smtp-viewer/AdminSmtpViewer';
import { AdminD3Auth } from './admin/sign-in/AdminD3Auth';
import { AppPasswords } from './screens/AppPasswords';
import { Aliases } from './screens/Aliases';
import { DeviceSetup } from './screens/DeviceSetup';
import { Import } from './screens/Import';
import { Mail } from './screens/Mail';
import { Rules } from './screens/Rules';
import { SenderProfile } from './screens/SenderProfile';
import { Sessions } from './screens/Sessions';
import { Setup } from './screens/Setup';
import { SetupWizard } from './screens/SetupWizard';
import { PaneBoundary } from './screens/PaneBoundary';
import { Shell } from './screens/Shell';
import { SignIn } from './screens/SignIn';
import { ReEnrol } from './screens/reenrol/ReEnrol';
import { InviteAccept } from './screens/invite/InviteAccept';
import { isInvitePath } from './screens/invite/token';
import { AdminPeople } from './screens/AdminPeople';

export const THEME_KEY = 'postroom-theme';

type ShellRouteId = Exclude<RouteId, 'setup' | 'signin' | 'invite' | 'mail' | 'mailFolder'>;

/** The element for every route in the table (PST-T-14.3). A route added to routes.ts without a
 * screen here fails the typecheck, so the table and the router cannot disagree. */
const SCREENS: Readonly<Record<ShellRouteId, ReactElement>> = {
  calendar: <Calendar />,
  contacts: <Contacts />,
  contactNew: <Contacts />,
  contactCard: <Contacts />,
  // PST-T-5.6: the sender profile, linked from the reading pane's From line.
  sender: <SenderProfile />,
  settingsAccount: <AccountScreen />,
  settingsBrowsers: <Sessions />,
  settingsDevices: <AppPasswords />,
  settingsDeviceSetup: <DeviceSetup />,
  settingsAddresses: <Aliases />,
  settingsRules: <Rules />,
  settingsTemplates: <TemplatesScreen />,
  settingsImport: <Import />,
  // PST-T-12.2: OpenPGP keys and S/MIME certificates.
  settingsKeys: <Keys />,
  adminHealth: <AdminHealth />,
  adminQueue: <AdminQueue />,
  adminDeliverability: <AdminDeliverability />,
  adminDns: <AdminDns />,
  adminSmtp: <AdminSmtpViewer />,
  adminJobs: <AdminJobs />,
  adminSessions: <AdminSessions />,
  // PST-T-20.2/20.3: invites, and deletions in their grace period.
  adminPeople: <AdminPeople />,
  // PST-T-17.7: Sign in with D3 Auth, configured from the console.
  adminSignIn: <AdminD3Auth />,
  adminSuppressions: <AdminSuppressions />,
  adminSetup: <SetupWizard />,
};

const isShellRoute = (id: RouteId): id is ShellRouteId => id !== 'setup' && id !== 'signin' && id !== 'invite' && id !== 'mail' && id !== 'mailFolder';

/** An old URL (/account/*, /app-passwords) lands on its new home, keeping its query string. */
function Moved({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={{ pathname: to, search: location.search }} replace />;
}


function Gate() {
  const location = useLocation();
  const [state, setState] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // PST-DA-043: the tab, browser history and screen readers all named the same 'Postroom' on every
  // screen. Set on every navigation, not just the mount, so a route change without a full reload
  // (React Router's own point) still updates it.
  useEffect(() => {
    document.title = titleForPath(location.pathname);
  }, [location.pathname]);

  if (failed) {
    return (
      <EntryShell>
        <EntryHeading title="Postroom is not answering" focusOnMount />
        <Alert
          tone="danger"
          title="Could not reach the server"
          actions={<Button size="sm" onClick={() => void refresh()}>Try again</Button>}
        >
          {serverUnreachable()}
        </Alert>
      </EntryShell>
    );
  }
  if (state === null) {
    return (
      <EntryShell>
        <EntryHeading title="Postroom" />
        <Spinner label="Loading" />
      </EntryShell>
    );
  }

  // PST-T-20.2: an invite link is for someone with no account yet — before any sign-in redirect.
  if (isInvitePath(location.pathname)) return <InviteAccept />;

  const target = redirectFor(state, location.pathname, location.search);
  if (target !== null && target !== location.pathname) return <Navigate to={target} replace />;
  // PST-T-16.26 (PST-REQ-200): signed in with a recovery code, the account replaces its lost
  // authenticator before anything else — on every load, so a reload cannot skip it.
  if (state.signedIn && state.reenrolRequired === true) return <ReEnrol onDone={refresh} />;

  return (
    <Routes>
      <Route path="/setup" element={<Setup onDone={refresh} />} />
      <Route path="/signin" element={<SignIn state={state} onSignedIn={refresh} />} />
      <Route
        element={
          <MailProvider me={state.account?.address ?? null}>
            <Shell state={state} onSignedOut={refresh} />
          </MailProvider>
        }
      >
        {/* PST-T-16.4: one Inbox URL — '/' (and '/?compose=new', sign-in's landing) goes to /mail/inbox. */}
        <Route index element={<Moved to={MAIL_HOME} />} />
        {/* One layout route for every mail URL, so moving between them never remounts the view. */}
        <Route element={<Mail />}>
          <Route path="/mail/*" element={null} />
        </Route>
        {ROUTES.filter((r) => isShellRoute(r.id)).map((r) => (
          <Route key={r.id} path={r.path} element={isShellRoute(r.id) ? SCREENS[r.id] : null} />
        ))}
        {REDIRECTS.map((r) => (
          <Route key={r.from} path={r.from} element={<Moved to={r.to} />} />
        ))}
        <Route path="*" element={<Navigate to={MAIL_HOME} replace />} />
      </Route>
    </Routes>
  );
}

/** PST-T-16.2: the root boundary. A throw in Gate, SignIn or Setup used to unmount the whole app
 * and leave an empty #root; now the page says it stopped working and offers Try again or Reload. */
function RootBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <PaneBoundary name="Postroom" resetKey={location.pathname} reload>
      {children}
    </PaneBoundary>
  );
}

export function App() {
  return (
    <ThemeProvider storageKey={THEME_KEY}>
      {/* PST-T-14.5: one polite live region for every toast (the triage Undo). */}
      <ToastRegion>
        <BrowserRouter>
          <RootBoundary>
            <Gate />
          </RootBoundary>
        </BrowserRouter>
      </ToastRegion>
    </ThemeProvider>
  );
}
