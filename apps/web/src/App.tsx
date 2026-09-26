import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Alert, AuthLayout, Spinner, ThemeProvider } from '@d3cloud/ui';
import { api, redirectFor, type AuthState } from './api';
import { Calendar } from './calendar/Calendar';
import { Contacts } from './contacts/Contacts';
import { MailProvider } from './mail/MailContext';
import { AdminHealth } from './screens/AdminHealth';
import { AdminJobs } from './screens/AdminJobs';
import { AdminQueue } from './screens/AdminQueue';
import { AdminSessions } from './screens/AdminSessions';
import { AppPasswords } from './screens/AppPasswords';
import { ChangePassword } from './screens/ChangePassword';
import { DeviceSetup } from './screens/DeviceSetup';
import { Import } from './screens/Import';
import { Mail } from './screens/Mail';
import { Rules } from './screens/Rules';
import { Sessions } from './screens/Sessions';
import { Setup } from './screens/Setup';
import { Shell } from './screens/Shell';
import { SignIn } from './screens/SignIn';

export const THEME_KEY = 'postroom-theme';

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

  if (failed) {
    return (
      <AuthLayout title="Postroom is not answering">
        <Alert tone="danger" title="Could not reach the server">
          Reload the page in a moment.
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

  const target = redirectFor(state, location.pathname);
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
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/contacts/new" element={<Contacts />} />
        <Route path="/contacts/:addressBookId/:name" element={<Contacts />} />
        <Route path="/app-passwords" element={<AppPasswords />} />
        <Route path="/account/password" element={<ChangePassword />} />
        <Route path="/account/sessions" element={<Sessions />} />
        <Route path="/account/import" element={<Import />} />
        <Route path="/account/device-setup" element={<DeviceSetup />} />
        <Route path="/account/rules" element={<Rules />} />
        <Route path="/admin/sessions" element={<AdminSessions />} />
        <Route path="/admin/health" element={<AdminHealth />} />
        <Route path="/admin/jobs" element={<AdminJobs />} />
        <Route path="/admin/queue" element={<AdminQueue />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider storageKey={THEME_KEY}>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </ThemeProvider>
  );
}
