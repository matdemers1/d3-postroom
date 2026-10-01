// Settings › Account (PST-T-15.6, PST-T-17.12, PST-REQ-194), to the canvas (Settings.dc.html): one
// centred 680px column of Section cards made of SettingsRows — Profile, Sign-in and Preferences. The
// Password row's "Change…" opens the change-password form in place, inside the Sign-in card, rather
// than on a page of its own; Cancel (or the close button) folds it back and returns focus to "Change…".
//
// What is here is only what the API already has: the profile is read-only (there is no endpoint to
// rename an account or change its address — the Email row goes on to Addresses), two-factor shows its
// state (TOTP is enrolled at setup and nothing in the webmail manages it), Recovery codes counts what
// is left and makes a new set behind step-up (PST-REQ-197, moved here from Browser sessions), "Sign in
// with D3 Auth" is the link/unlink row (PST-T-17.7), and Preferences holds the theme alone: there are
// no server-side preferences, and one spacing scale for everyone (D-007).
import '../settings/settings.css';
import '../settings/account.css';
import { type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  CodeInput,
  FormActions,
  FormField,
  IconButton,
  Page,
  PageHeader,
  PasswordInput,
  PasswordStrength,
  Section,
  SettingsRow,
  StatusDot,
  ThemeSwitch,
} from '@d3cloud/ui';
import { api, describeError, type AuthState } from '../api';
import { scorePassword } from '../settings/password-strength';
import { AccountD3AuthRow } from '../admin/sign-in/AccountD3AuthRow';
import { RecoveryCodesSection } from '../settings/RecoveryCodesSection';
import { ChevronIcon } from '../mail/icons';
import { Loading, LoadFailed } from './states';

/**
 * Change password (PST-REQ-091; ASVS 5.0 6.2.2): current password and a fresh authenticator code,
 * then the policy that rejected the account when it was first set up. Every other session ends
 * unless the caller opts to keep them signed in (ASVS 5.0 7.4.3).
 *
 * PST-T-15.6: no longer a page of its own. Settings › Account's Password row opens it in place — a
 * 164 / 360 grid inside the Sign-in card, the strength verdict under "New password", the code as a
 * CodeInput, and Cancel / Update password on the right.
 */
export function ChangePasswordForm({
  id,
  totpEnabled,
  address = null,
  onChanged,
  onCancel,
}: {
  id: string;
  totpEnabled: boolean;
  /** The account's address: its domain's first label is one of the words the server refuses. */
  address?: string | null;
  /** Called with the sentence to show once the password has changed. */
  onChanged: (notice: string) => void;
  onCancel: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [endOtherSessions, setEndOtherSessions] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  // Opening the form moves focus into it, so a keyboard user lands where they asked to go.
  useEffect(() => {
    first.current?.focus();
  }, []);

  const mismatch = confirm !== '' && confirm !== newPassword;
  const strength = scorePassword(newPassword, undefined, address?.split('@')[1] ?? null);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (mismatch) return;
    setError(null);
    setBusy(true);
    api
      .changePassword({ currentPassword, newPassword, code, endOtherSessions })
      .then((result) => {
        onChanged(
          result.endedSessions > 0
            ? `Password changed. Signed out ${String(result.endedSessions)} other ${result.endedSessions === 1 ? 'session' : 'sessions'}.`
            : 'Password changed.',
        );
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
    <form id={id} className="pr-pwform" onSubmit={submit} aria-label="Change password">
      {error === null ? null : (
        <Alert tone="danger" title="Could not change password" dynamic>
          {error}
        </Alert>
      )}
      <FormField label="Current password" width="lg">
        <PasswordInput
          ref={first}
          name="currentPassword"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
          }}
        />
      </FormField>
      <FormField label="New password" width="lg" help={<PasswordStrength score={strength.score} label={strength.label} />}>
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
      <FormField label="Confirm new password" width="lg" {...(mismatch ? { error: 'The passwords do not match.' } : {})}>
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
      {totpEnabled ? (
        <FormField label="Authentication code" width="lg" help="From your authenticator app.">
          <CodeInput name="code" autoComplete="one-time-code" groups={[3, 3]} size="md" required value={code} onValueChange={setCode} />
        </FormField>
      ) : null}
      <FormActions
        className="pr-pwform__actions"
        leading={
          <Checkbox
            name="endOtherSessions"
            label="Sign out other sessions"
            checked={endOtherSessions}
            onCheckedChange={(checked) => {
              setEndOtherSessions(checked === true);
            }}
          />
        }
      >
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Update password
        </Button>
      </FormActions>
    </form>
  );
}

type Account = NonNullable<AuthState['account']>;

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function AccountScreen() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const formId = useId();

  const load = useCallback(async () => {
    try {
      const state = await api.state();
      if (state.account === undefined) throw new Error('signed out');
      setAccount(state.account);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Folding the form away hands focus back to the button that opened it.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      changeButton.current?.focus();
    }
  }, [editing]);

  const open = () => {
    setNotice(null);
    setEditing(true);
  };
  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  return (
    <Page width="narrow" align="center" className="pr-settings">
      <PageHeader title="Account" description="Your profile, how you sign in, and how Postroom looks." />
      {notice === null ? null : (
        <Alert tone="info" dynamic>
          {notice}
        </Alert>
      )}

      {loadError !== null ? (
        <LoadFailed error={loadError} what="your account" onRetry={() => void load()} />
      ) : account === null ? (
        <Loading label="Loading your account" />
      ) : (
        <>
          <Section title="Profile">
            <SettingsRow
              title="Display name"
              description="On mail you send, and beside your name in Postroom."
              control={
                <span className="pr-set-value">
                  <Avatar name={account.displayName} tint="auto" size="md" />
                  <span>{account.displayName}</span>
                </span>
              }
            />
            {account.address === null ? null : (
              <SettingsRow
                title="Email address"
                description="Where your mail arrives. Masked aliases are under Addresses."
                control={
                  <span className="pr-set-value">
                    <span className="pr-set-mono">{account.address}</span>
                    <RouterLink className="pr-account-go d3-ibtn d3-ibtn--sm" to="/settings/addresses" aria-label="Manage addresses">
                      <ChevronIcon />
                    </RouterLink>
                  </span>
                }
              />
            )}
          </Section>

          <Section title="Sign-in">
            <SettingsRow
              title="Password"
              description="Signs you in on the web. Mail apps use app passwords."
              control={
                editing ? (
                  <IconButton label="Close password form" icon={<CloseIcon />} size="sm" aria-expanded="true" aria-controls={formId} onClick={close} />
                ) : (
                  <Button ref={changeButton} size="sm" aria-label="Change password" aria-expanded="false" onClick={open}>
                    Change…
                  </Button>
                )
              }
            />
            {editing ? (
              <ChangePasswordForm
                id={formId}
                totpEnabled={account.totpEnabled}
                address={account.address}
                onCancel={close}
                onChanged={(text) => {
                  setNotice(text);
                  close();
                }}
              />
            ) : null}
            <SettingsRow
              title="Two-factor authentication"
              description="Asked at sign-in and before anything destructive."
              control={
                // Healthy reads neutral and only what needs you takes a hue (D-016): @d3cloud/ui's
                // StatusDot has no success tone, so "On" is the neutral dot.
                account.totpEnabled ? (
                  <StatusDot size="sm" tone="neutral">
                    On · Authenticator app
                  </StatusDot>
                ) : (
                  <StatusDot size="sm" tone="attention">
                    Off
                  </StatusDot>
                )
              }
            />
            {/* PST-T-17.12 (PST-REQ-197): how many recovery codes are left, and a new set behind step-up. */}
            <RecoveryCodesSection />
            {/* PST-T-17.7 (PST-REQ-202): link or unlink D3 Auth; absent while D3 Auth is not available. */}
            <AccountD3AuthRow />
          </Section>

          <Section title="Preferences">
            <SettingsRow title="Theme" description="System follows your device’s appearance." control={<ThemeSwitch label="Theme" size="sm" />} />
          </Section>
        </>
      )}
    </Page>
  );
}
