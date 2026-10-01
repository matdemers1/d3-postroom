import '../styles/fields.css';
import './setup/totp.css';
import { type SyntheticEvent, useState } from 'react';
import {
  Alert,
  AuthLayout,
  Button,
  Card,
  Cluster,
  DescriptionItem,
  DescriptionList,
  FormActions,
  FormField,
  Input,
  Link,
  PasswordInput,
  Stack,
} from '@d3cloud/ui';
import { api, ApiError, describeError } from '../api';
import { DOMAIN, type Field, localPartOf, loginProblem, serverFieldErrors } from '../setup-login';
import { CopyButton } from './AdminDns';
import { AFTER_SETUP, afterCompleteFailure, EMPTY_SETUP_FORM, keyGroups, type SetupForm, startOver } from './setup/enrolment';
import { TotpQr } from './setup/TotpQr';

const MIN_PASSWORD = 12;
/**
 * First run, once (PST-REQ-006): name the operator, choose a login and password, then enrol an
 * authenticator. Setup is not complete — and nothing is saved — until a code proves it works.
 * The key is shown as a QR drawn in the browser and in four-character groups (PST-REQ-196); an
 * enrolment that expired goes back to the first step with what was typed (PST-DA-038); and the
 * operator then lands on the setup wizard, not an empty Inbox (PST-DA-036).
 */
// `onDone` (App's auth refresh) is no longer called: see `complete` for why the page loads afresh.
export function Setup(_props: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState<SetupForm>(EMPTY_SETUP_FORM);
  const { setupToken, displayName, login, password, confirm, enrol, code, error } = form;
  const set = (patch: Partial<SetupForm>) => {
    setForm((f) => ({ ...f, ...patch }));
  };
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});

  const loginError = loginProblem(login) ?? fieldErrors.login;
  const mismatch = confirm !== '' && confirm !== password;
  const tooShort = password !== '' && password.length < MIN_PASSWORD;

  const begin = (event: SyntheticEvent) => {
    event.preventDefault();
    if (mismatch || tooShort || loginProblem(login) !== null) return;
    setFieldErrors({});
    setBusy(true);
    const local = localPartOf(login);
    set({ login: local, error: null });
    api
      .setupBegin({ setupToken, displayName, login: local, password })
      .then((result) => {
        set({ enrol: result, code: '' });
      })
      .catch((caught: unknown) => {
        const fields = serverFieldErrors(caught);
        setFieldErrors(fields);
        // The banner names the fields only when one of them is actually marked.
        const named = Object.keys(fields).length > 0;
        set({ error: named ? 'Fix the marked field and continue.' : caught instanceof ApiError && caught.code === 'invalid_request' ? 'The server refused the form. Check every field and try again.' : describeError(caught) });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const complete = (event: SyntheticEvent) => {
    event.preventDefault();
    if (enrol === null) return;
    set({ error: null });
    setBusy(true);
    api
      .setupComplete({ setupToken, enrolToken: enrol.enrolToken, code })
      .then(() => {
        // A full load, not a router navigation: refreshing the auth state first would let the Gate
        // send /setup to /signin and on to '/' (its redirect renders at a higher priority than the
        // router's transition), so the operator would land on the empty Inbox instead of the wizard.
        // The session cookie is already set; the fresh load reads the new state and renders it.
        window.location.replace(AFTER_SETUP);
      })
      .catch((caught: unknown) => {
        // An expired enrolment can't be retried: back to the first step, keeping what was typed.
        setForm((f) => afterCompleteFailure(f, caught));
        // Only on failure: on success the button stays busy until the page has gone.
        setBusy(false);
      });
  };

  return (
    <AuthLayout
      title="Set up Postroom"
      description={enrol === null ? 'Create the operator account. This screen is shown once.' : 'Enrol your authenticator.'}
      focusOnMount={false}
    >
      <Card>
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" title="Setup did not finish" dynamic>
              {error}
            </Alert>
          )}
          {enrol === null ? (
            <Stack as="form" gap="16" onSubmit={begin} aria-label="Operator account">
              <FormField label="Setup token" help="Printed in the server's env file (SETUP_TOKEN)." {...(fieldErrors.setupToken === undefined ? {} : { error: fieldErrors.setupToken })}>
                <PasswordInput
                  name="setupToken"
                  autoComplete="off"
                  autoFocus
                  value={setupToken}
                  onChange={(e) => {
                    set({ setupToken: e.target.value.trim() });
                  }}
                />
              </FormField>
              <FormField label="Display name" {...(fieldErrors.displayName === undefined ? {} : { error: fieldErrors.displayName })}>
                <Input appearance="filled"
                  name="displayName"
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={(e) => {
                    set({ displayName: e.target.value });
                  }}
                />
              </FormField>
              <FormField label="Username" help={`Just the name. It becomes your address: name@${DOMAIN}.`} {...(loginError === undefined ? {} : { error: loginError })}>
                <Input appearance="filled"
                  name="login"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={login}
                  onChange={(e) => {
                    set({ login: e.target.value.toLowerCase() });
                    setFieldErrors(({ login: _dropped, ...rest }) => rest);
                  }}
                  onBlur={() => {
                    setForm((f) => ({ ...f, login: localPartOf(f.login) }));
                  }}
                />
              </FormField>
              <FormField
                label="Password"
                help={`At least ${String(MIN_PASSWORD)} characters. Web sign-in only — mail apps use app passwords.`}
                {...(tooShort ? { error: `Use at least ${String(MIN_PASSWORD)} characters.` } : fieldErrors.password === undefined ? {} : { error: fieldErrors.password })}
              >
                <PasswordInput
                  name="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => {
                    set({ password: e.target.value });
                  }}
                />
              </FormField>
              <FormField label="Confirm password" {...(mismatch ? { error: 'The passwords do not match.' } : {})}>
                <PasswordInput
                  name="confirm"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => {
                    set({ confirm: e.target.value });
                  }}
                />
              </FormField>
              <FormActions layout="stack">
                <Button type="submit" variant="primary" loading={busy}>
                  Continue
                </Button>
              </FormActions>
            </Stack>
          ) : (
            <Stack as="form" gap="16" onSubmit={complete} aria-label="Enrol an authenticator">
              <p>
                Scan this code with your authenticator app, then enter the six-digit code it shows. Can’t scan
                it? Type the key by hand, or open the link on this phone.
              </p>
              <TotpQr uri={enrol.otpauthUri} />
              <DescriptionList>
                <DescriptionItem term="Setup key">
                  <Cluster gap="8" align="center">
                    <code className="pr-totp-key" data-testid="totp-secret">
                      {keyGroups(enrol.secret).map((group, i) => (
                        <span key={String(i)}>{group}</span>
                      ))}
                    </code>
                    <CopyButton value={enrol.secret} label="setup key" />
                  </Cluster>
                </DescriptionItem>
                <DescriptionItem term="Authenticator link">
                  <Link href={enrol.otpauthUri} variant="inline" data-testid="totp-uri">
                    Open in authenticator
                  </Link>
                </DescriptionItem>
              </DescriptionList>
              <FormField label="Authentication code">
                <Input appearance="filled"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => {
                    set({ code: e.target.value });
                  }}
                />
              </FormField>
              <FormActions layout="stack">
                <Button type="submit" variant="primary" loading={busy}>
                  Finish setup
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setForm(startOver);
                  }}
                >
                  Start over
                </Button>
              </FormActions>
            </Stack>
          )}
        </Stack>
      </Card>
    </AuthLayout>
  );
}
