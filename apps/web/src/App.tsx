import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Alert, AuthLayout, Button, Spinner, ThemeProvider, ToastRegion } from '@d3cloud/ui';
import { api, redirectFor, serverUnreachable, type AuthState } from './api';
import { REDIRECTS, ROUTES, type RouteId } from './routes';
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
import { Shell } from './screens/Shell';
import { SignIn } from './screens/SignIn';

export const THEME_KEY = 'postroom-theme';

type ShellRouteId = Exclude<RouteId, 'setup' | 'signin' | 'mail' | 'mailFolder'>;

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
  adminSuppressions: <AdminSuppressions />,
  adminSetup: <SetupWizard />,
};

const isShellRoute = (id: RouteId): id is ShellRouteId => id !== 'setup' && id !== 'signin' && id !== 'mail' && id !== 'mailFolder';

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
      <AuthLayout title="Postroom is not answering">
        <Alert
          tone="danger"
          title="Could not reach the server"
          actions={<Button size="sm" onClick={() => void refresh()}>Try again</Button>}
        >
          {serverUnreachable()}
        </Alert>
      </AuthLayout>
    );
  }
  if (state === null) {
    return (
      <AuthLayout title="Postroom" focusOnMount={false}>
        <Spinner label="Loading" />
      </AuthLayout>
    );
  }

  const target = redirectFor(state, location.pathname, location.search);
  if (target !== null && target !== location.pathname) return <Navigate to={target} replace />;

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
        {/* One layout route for every mail URL, so moving between them never remounts the view. */}
        <Route element={<Mail />}>
          <Route index element={null} />
          <Route path="/mail/*" element={null} />
        </Route>
        {ROUTES.filter((r) => isShellRoute(r.id)).map((r) => (
          <Route key={r.id} path={r.path} element={isShellRoute(r.id) ? SCREENS[r.id] : null} />
        ))}
        {REDIRECTS.map((r) => (
          <Route key={r.from} path={r.from} element={<Moved to={r.to} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider storageKey={THEME_KEY}>
      {/* PST-T-14.5: one polite live region for every toast (the triage Undo). */}
      <ToastRegion>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </ToastRegion>
    </ThemeProvider>
  );
}
