import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, AuthLayout, Button, Card, FormActions, FormField, Input, PasswordInput, Stack, Link } from '@d3cloud/ui';
import { api, describeError, type AuthState } from '../api';

/**
 * Two ways in, side by side (PST-REQ-005). The password form is always here; the D3 Auth button
 * appears when it is configured, and is disabled with a reason while the issuer is unreachable —
 * this is the screen someone reaches exactly when that is the thing that is broken.
 */
export function SignIn({ state, onSignedIn }: { state: AuthState; onSignedIn: () => Promise<void> }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkAfter, setLinkAfter] = useState(false);
  const [busy, setBusy] = useState(false);

  // A refused D3 Auth sign-in comes back as a redirect carrying its reason. Read once, then
  // cleared from the URL so a reload does not re-announce it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get('signin_error');
    if (reason === null) return;
    setError(reason);
    setLinkAfter(params.get('link_after_signin') === '1');
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submitPassword = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    api
      .signIn({ login, password })
      .then((result) => {
        setChallenge(result.challenge);
        setPassword('');
      })
      .catch((caught: unknown) => {
        setError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const submitCode = (event: SyntheticEvent) => {
    event.preventDefault();
    if (challenge === null) return;
    setError(null);
    setBusy(true);
    api
      .signInTotp({ challenge, code })
      .then(async () => {
        if (linkAfter) {
          // A real navigation: the server answers with a redirect to D3 Auth.
          window.location.assign('/api/auth/oidc/start?link=1');
          return;
        }
        await onSignedIn();
      })
      .catch((caught: unknown) => {
        setCode('');
        setError(describeError(caught));
        if (caught instanceof Error && caught.message === 'challenge_expired') setChallenge(null);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <AuthLayout
      title="Sign in to Postroom"
      description={challenge === null ? 'Your d3cloud.io mail.' : 'One more step: the code from your authenticator.'}
      focusOnMount={false}
    >
      <Card>
        <Stack gap="16">
          {error === null ? null : (
            <Alert tone="danger" title="Sign-in failed" dynamic>
              {error}
            </Alert>
          )}

          {challenge === null ? (
            <Stack as="form" gap="16" onSubmit={submitPassword} aria-label="Sign in with your password">
              <FormField label="Login" help="Your address, or just the part before @d3cloud.io.">
                <Input
                  name="login"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  required
                  value={login}
                  onChange={(e) => {
                    setLogin(e.target.value);
                  }}
                />
              </FormField>
              <FormField label="Password">
                <PasswordInput
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                />
              </FormField>
              <FormActions layout="stack">
                <Button type="submit" variant="primary" loading={busy}>
                  Sign in
                </Button>
              </FormActions>
            </Stack>
          ) : (
            <Stack as="form" gap="16" onSubmit={submitCode} aria-label="Enter your authentication code">
              <FormField label="Authentication code" help="Six digits from your authenticator app.">
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
              <FormActions
                layout="stack"
                leading={
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setChallenge(null);
                      setCode('');
                    }}
                  >
                    Start over
                  </Button>
                }
              >
                <Button type="submit" variant="primary" loading={busy}>
                  Verify
                </Button>
              </FormActions>
            </Stack>
          )}

          {state.oidcConfigured ? (
            state.oidcAvailable ? (
              // A link, not a fetch: the provider's redirect is a top-level navigation.
              <Link href="/api/auth/oidc/start" variant="standalone">
                Sign in with D3 Auth
              </Link>
            ) : (
              <Stack gap="8">
                <Button type="button" variant="secondary" disabled>
                  Sign in with D3 Auth
                </Button>
                <Alert tone="info">D3 Auth is unreachable right now. Your password still works.</Alert>
              </Stack>
            )
          ) : null}
        </Stack>
      </Card>
    </AuthLayout>
  );
}
