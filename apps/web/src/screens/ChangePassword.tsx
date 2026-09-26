import { type SyntheticEvent, useState } from 'react';
import { Alert, Button, Checkbox, FormActions, FormField, Input, Page, PageHeader, PasswordInput, Section, Stack } from '@d3cloud/ui';
import { api, describeError } from '../api';

const MIN_PASSWORD = 12;

/**
 * Change password (PST-REQ-091; ASVS 5.0 6.2.2): current password and a fresh authenticator code,
 * then the policy that rejected the account when it was first set up. Every other session ends
 * unless the caller opts to keep them signed in (ASVS 5.0 7.4.3).
 */
export function ChangePassword() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [endOtherSessions, setEndOtherSessions] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm !== '' && confirm !== newPassword;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (mismatch) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    api
      .changePassword({ currentPassword, newPassword, code, endOtherSessions })
      .then((result) => {
        setNotice(
          result.endedSessions > 0
            ? `Password changed. Signed out ${String(result.endedSessions)} other ${result.endedSessions === 1 ? 'session' : 'sessions'}.`
            : 'Password changed.',
        );
        setCurrentPassword('');
        setNewPassword('');
        setConfirm('');
        setCode('');
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
    <Page>
      <PageHeader title="Change password" description="Your web sign-in password. Mail apps use app passwords instead." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}
      <Section title="Change your password">
        <form onSubmit={submit} aria-label="Change password">
          <Stack gap="16">
            {error === null ? null : (
              <Alert tone="danger" title="Could not change password" dynamic>
                {error}
              </Alert>
            )}
            <FormField label="Current password">
              <PasswordInput
                name="currentPassword"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                }}
              />
            </FormField>
            <FormField label="New password" help={`At least ${String(MIN_PASSWORD)} characters.`}>
              <PasswordInput
                name="newPassword"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                }}
              />
            </FormField>
            <FormField label="Confirm new password" {...(mismatch ? { error: 'The passwords do not match.' } : {})}>
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
            <FormField label="Authentication code" help="A fresh code from your authenticator.">
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*"
                required
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                }}
              />
            </FormField>
            <Checkbox
              name="endOtherSessions"
              label="Sign out every other session"
              checked={endOtherSessions}
              onCheckedChange={(checked) => {
                setEndOtherSessions(checked === true);
              }}
            />
            <FormActions>
              <Button type="submit" variant="primary" loading={busy}>
                Change password
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Section>
    </Page>
  );
}
