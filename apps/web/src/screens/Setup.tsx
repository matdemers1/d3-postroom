import { type SyntheticEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  AuthLayout,
  Button,
  Card,
  DescriptionItem,
  DescriptionList,
  FormActions,
  FormField,
  Input,
  Link,
  PasswordInput,
  Stack,
} from '@d3cloud/ui';
import { api, describeError } from '../api';

const MIN_PASSWORD = 12;

/**
 * First run, once (PST-REQ-006): name the operator, choose a login and password, then enrol an
 * authenticator. Setup is not complete — and nothing is saved — until a code proves it works.
 */
export function Setup({ onDone }: { onDone: () => Promise<void> }) {
  const navigate = useNavigate();
  const [setupToken, setSetupToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [enrol, setEnrol] = useState<{ enrolToken: string; secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm !== '' && confirm !== password;
  const tooShort = password !== '' && password.length < MIN_PASSWORD;

  const begin = (event: SyntheticEvent) => {
    event.preventDefault();
    if (mismatch || tooShort) return;
    setError(null);
    setBusy(true);
    api
      .setupBegin({ setupToken, displayName, login, password })
      .then((result) => {
        setEnrol(result);
      })
      .catch((caught: unknown) => {
        setError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const complete = (event: SyntheticEvent) => {
    event.preventDefault();
    if (enrol === null) return;
    setError(null);
    setBusy(true);
    api
      .setupComplete({ setupToken, enrolToken: enrol.enrolToken, code })
      .then(async () => {
        await onDone();
        void navigate('/', { replace: true });
      })
      .catch((caught: unknown) => {
        setCode('');
        setError(describeError(caught));
      })
      .finally(() => {
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
              <FormField label="Setup token" help="Printed in the server's env file (SETUP_TOKEN).">
                <PasswordInput
                  name="setupToken"
                  autoComplete="off"
                  autoFocus
                  value={setupToken}
                  onChange={(e) => {
                    setSetupToken(e.target.value.trim());
                  }}
                />
              </FormField>
              <FormField label="Display name">
                <Input
                  name="displayName"
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Login" help="Becomes your address: login@d3cloud.io.">
                <Input
                  name="login"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={login}
                  onChange={(e) => {
                    setLogin(e.target.value.toLowerCase());
                  }}
                />
              </FormField>
              <FormField
                label="Password"
                help={`At least ${String(MIN_PASSWORD)} characters. Web sign-in only — mail apps use app passwords.`}
                {...(tooShort ? { error: `Use at least ${String(MIN_PASSWORD)} characters.` } : {})}
              >
                <PasswordInput
                  name="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
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
                    setConfirm(e.target.value);
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
                Add this account to your authenticator app, then enter the six-digit code it shows. Open the link on
                a phone, or type the key by hand.
              </p>
              <DescriptionList>
                <DescriptionItem term="Setup key">
                  <code data-testid="totp-secret">{enrol.secret}</code>
                </DescriptionItem>
                <DescriptionItem term="Authenticator link">
                  <Link href={enrol.otpauthUri} variant="inline" data-testid="totp-uri">
                    Open in authenticator
                  </Link>
                </DescriptionItem>
              </DescriptionList>
              <FormField label="Authentication code">
                <Input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                  }}
                />
              </FormField>
              <FormActions layout="stack">
                <Button type="submit" variant="primary" loading={busy}>
                  Finish setup
                </Button>
              </FormActions>
            </Stack>
          )}
        </Stack>
      </Card>
    </AuthLayout>
  );
}
