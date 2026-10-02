import '../styles/fields.css';
import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, AuthLayout, Button, Card, FormActions, FormField, Input, PasswordInput, Stack, Link } from '@d3cloud/ui';
import { PostroomMark } from '../brand/PostroomMark';
import { signinNoticeFrom } from '../admin/sign-in/model';
import { api, describeError, type AuthState } from '../api';
import { describeRecoveryError, USE_AUTHENTICATOR_LABEL, USE_RECOVERY_LABEL } from './recovery/codes';
import { reenrolApi } from './reenrol/api';
import { ReEnrol } from './reenrol/ReEnrol';
import { needsReenrol } from './reenrol/reenrolment';

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
  /** PST-REQ-197: the second step takes a recovery code in place of the TOTP code. */
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkAfter, setLinkAfter] = useState(false);
  /**
   * PST-T-17.16 (PST-ADR-015): D3 Auth reached no linked account. Why, and that signing in here goes
   * on to link it — kept through both steps, unlike an error, which the next attempt clears.
   */
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * PST-REQ-200: a recovery code signed this session in, so it sets up a new authenticator here
   * before going on — the auth state is refreshed only once that is done.
   */
  const [reenrol, setReenrol] = useState(false);

  // A refused D3 Auth sign-in comes back as a redirect carrying its reason. Read once, then
  // cleared from the URL so a reload does not re-announce it.
  useEffect(() => {
    const notice = signinNoticeFrom(window.location.search);
    if (notice === null) return;
    if (notice.linkAfter) setLinkNotice(notice.message);
    else setError(notice.message);
    setLinkAfter(notice.linkAfter);
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
        setUseRecovery(false);
        setPassword('');
      })
      .catch((caught: unknown) => {
        setError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  /** Signed in (and re-enrolled, when that was needed): on to D3 Auth linking, or into the app. */
  const carryOn = async () => {
    if (linkAfter) {
      // A real navigation: the server answers with a redirect to D3 Auth.
      window.location.assign('/api/auth/oidc/start?link=1');
      return;
    }
    await onSignedIn();
  };

  const submitCode = (event: SyntheticEvent) => {
    event.preventDefault();
    if (challenge === null) return;
    setError(null);
    setBusy(true);
    reenrolApi
      .signInTotp({ challenge, code })
      .then(async (result) => {
        if (needsReenrol(result)) {
          setReenrol(true);
          return;
        }
        await carryOn();
      })
      .catch((caught: unknown) => {
        setCode('');
        setError(useRecovery ? describeRecoveryError(caught) : describeError(caught));
        if (caught instanceof Error && caught.message === 'challenge_expired') setChallenge(null);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (reenrol) return <ReEnrol onDone={carryOn} />;

  return (
    <AuthLayout
      title="Sign in to Postroom"
      description={
        challenge === null
          ? 'Your own mail server for d3cloud.io — every message sorted, explained and yours.'
          : useRecovery
            ? 'One more step: one of your recovery codes.'
            : 'One more step: the code from your authenticator.'
      }
      brand={<PostroomMark size={40} decorative />}
      focusOnMount={false}
    >
      <Card>
        <Stack gap="16">
          {linkNotice === null ? null : (
            <Alert tone="info" title="Sign in to link D3 Auth" dynamic>
              {linkNotice}
            </Alert>
          )}
          {error === null ? null : (
            <Alert tone="danger" title="Sign-in failed" dynamic>
              {error}
            </Alert>
          )}

          {challenge === null ? (
            <Stack as="form" gap="16" onSubmit={submitPassword} aria-label="Sign in with your password">
              <FormField label="Address or username" help="Your address, or just the part before @d3cloud.io.">
                <Input appearance="filled"
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
            <Stack
              as="form"
              gap="16"
              onSubmit={submitCode}
              aria-label={useRecovery ? 'Enter a recovery code' : 'Enter your authentication code'}
            >
              {useRecovery ? (
                <FormField label="Recovery code" help="One of the ten codes you saved, like ABCDE-12345. Each works once.">
                  <Input appearance="filled"
                    key="recovery"
                    name="recoveryCode"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    autoFocus
                    required
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                    }}
                  />
                </FormField>
              ) : (
                <FormField label="Authentication code" help="Six digits from your authenticator app.">
                  <Input appearance="filled"
                    key="totp"
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
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setUseRecovery((r) => !r);
                  setCode('');
                  setError(null);
                }}
              >
                {useRecovery ? USE_AUTHENTICATOR_LABEL : USE_RECOVERY_LABEL}
              </Button>
              <FormActions
                layout="stack"
                leading={
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setChallenge(null);
                      setUseRecovery(false);
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
