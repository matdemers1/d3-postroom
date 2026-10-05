import '../../styles/fields.css';
import '../setup/totp.css';
import { type SyntheticEvent, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Alert, Button, Cluster, DescriptionItem, DescriptionList, FormActions, FormField, Input, Link, PasswordInput, Stack } from '@d3cloud/ui';
import { ApiError, api, describeError, type InviteEnrolment } from '../../api';
import { EntryHeading, EntryShell } from '../../entry/EntryShell';
import { CopyButton } from '../AdminDns';
import { RecoveryCodes } from '../recovery/RecoveryCodes';
import { keyGroups } from '../setup/enrolment';
import { TotpQr } from '../setup/TotpQr';
import { inviteTokenOf } from './token';

const MIN_PASSWORD = 12;
const AFTER_INVITE = '/mail/inbox';

/**
 * Accepting an invite on the web (PST-T-20.2): choose a name and a password — the account exists
 * from here — then enrol an authenticator, save the ten recovery codes, and land in the Inbox signed
 * in. D3 Constellation takes the same two steps natively. An account left without its authenticator
 * is finished by opening the same link with the same password.
 */
export function InviteAccept() {
  const location = useLocation();
  const token = inviteTokenOf(location.pathname, location.search);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [enrol, setEnrol] = useState<InviteEnrolment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(token === null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ codes: string[]; address: string; at: Date } | null>(null);

  const mismatch = confirm !== '' && confirm !== password;
  const tooShort = password !== '' && password.length < MIN_PASSWORD;

  const begin = (event: SyntheticEvent) => {
    event.preventDefault();
    if (token === null || mismatch || tooShort) return;
    setBusy(true);
    setError(null);
    api
      .inviteAccept({ token, displayName, password })
      .then((result) => {
        setEnrol(result);
        setCode('');
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.code === 'invite_invalid') setDead(true);
        else setError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const complete = (event: SyntheticEvent) => {
    event.preventDefault();
    if (enrol === null) return;
    setBusy(true);
    setError(null);
    api
      .inviteEnrol({ challenge: enrol.challenge, enrolTotp: code.replace(/\s+/g, '') })
      .then((result) => {
        setRecovery({ codes: result.recoveryCodes, address: result.address, at: new Date() });
      })
      .catch((caught: unknown) => {
        setCode('');
        setError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  // A full load: the Gate reads the new session's state afresh.
  const finish = () => {
    window.location.replace(AFTER_INVITE);
  };

  return (
    <EntryShell wide>
      <EntryHeading title="Join Postroom" focusOnMount>
        {dead
          ? 'This invite can’t be used.'
          : recovery !== null
            ? 'Save your recovery codes.'
            : enrol === null
              ? 'You’ve been invited to an account here. Choose your name and a password.'
              : `Your address is ${enrol.address}. Now enrol your authenticator.`}
      </EntryHeading>
      <div className="pr-entry__body">
        {error === null ? null : (
          <Alert tone="danger" title="That didn’t work" dynamic>
            {error}
          </Alert>
        )}
        {dead ? (
          <Stack gap="16">
            <Alert tone="warning" title="Invite not usable">
              It has been used, withdrawn or has expired. Ask whoever invited you for a new link. If you already
              finished setting up, sign in instead.
            </Alert>
            <Link href="/signin">Go to sign in</Link>
          </Stack>
        ) : recovery !== null ? (
          <Stack gap="16">
            <p>Your account is ready. If you ever lose your authenticator, sign in with one of these codes instead.</p>
            <RecoveryCodes codes={recovery.codes} address={recovery.address} createdAt={recovery.at} continueLabel="Continue to Mail" onContinue={finish} />
          </Stack>
        ) : enrol === null ? (
          <Stack as="form" gap="16" onSubmit={begin} aria-label="Your account">
            <FormField label="Display name" help="How your name appears on mail you send.">
              <Input
                appearance="filled"
                name="displayName"
                autoComplete="name"
                autoFocus
                required
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
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
            <p>Scan this code with your authenticator app, then enter the six-digit code it shows.</p>
            <TotpQr uri={enrol.enrolment.otpauthUri} />
            <DescriptionList>
              <DescriptionItem term="Setup key">
                <Cluster gap="8" align="center">
                  <code className="pr-totp-key" data-testid="totp-secret">
                    {keyGroups(enrol.enrolment.secret).map((group, i) => (
                      <span key={String(i)}>{group}</span>
                    ))}
                  </code>
                  <CopyButton value={enrol.enrolment.secret} label="setup key" />
                </Cluster>
              </DescriptionItem>
              <DescriptionItem term="Authenticator link">
                <Link href={enrol.enrolment.otpauthUri} variant="inline">
                  Open in authenticator
                </Link>
              </DescriptionItem>
            </DescriptionList>
            <FormField label="Authentication code">
              <Input
                appearance="filled"
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
                Finish
              </Button>
            </FormActions>
          </Stack>
        )}
      </div>
    </EntryShell>
  );
}
