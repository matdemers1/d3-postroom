import '../../styles/fields.css';
import '../setup/totp.css';
import { type SyntheticEvent, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Cluster,
  DescriptionItem,
  DescriptionList,
  FormActions,
  FormField,
  Input,
  Link,
  Spinner,
  Stack,
} from '@d3cloud/ui';
import { EntryHeading, EntryShell } from '../../entry/EntryShell';
import { CopyButton } from '../AdminDns';
import { RecoveryCodes } from '../recovery/RecoveryCodes';
import { keyGroups } from '../setup/enrolment';
import { TotpQr } from '../setup/TotpQr';
import { reenrolApi, type ReenrolKey } from './api';
import {
  describeReenrolError,
  isReenrolDone,
  isReenrolKeyGone,
  REENROL_CONTINUE_LABEL,
  REENROL_DESCRIPTION,
  REENROL_EXPIRED_MESSAGE,
  REENROL_SUBMIT_LABEL,
  REENROL_TITLE,
} from './reenrolment';

/**
 * 'Set up a new authenticator' (PST-REQ-200). A recovery code stood in for a lost authenticator,
 * so before anything that needs a fresh second factor this session enrols a new one: the same QR and
 * grouped key as first-run setup (PST-REQ-196), a code to prove it, and then the ten new recovery
 * codes that replace the old set (PST-REQ-197), shown once behind "I have saved these". Completing
 * it is what invalidates the old authenticator; `onDone` carries on to where the person was going.
 */
export function ReEnrol({ onDone }: { onDone: () => void | Promise<void> }) {
  const [key, setKey] = useState<ReenrolKey | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * A new round asks the server for a new key: on arrival, after one expired (with the banner that
   * says so), and on Try again.
   */
  const [round, setRound] = useState<{ n: number; banner: string | null }>({ n: 0, banner: null });
  const [recovery, setRecovery] = useState<{ codes: string[]; at: Date } | null>(null);

  useEffect(() => {
    // Ignore an answer that arrives after this round was replaced (a strict-mode double run, or a
    // retry), so the key on screen is always the one the server will check the code against.
    let live = true;
    setBusy(true);
    reenrolApi
      .begin()
      .then((next) => {
        if (!live) return;
        setKey(next);
        setCode('');
        setError(round.banner);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        if (isReenrolDone(caught)) {
          void onDone();
          return;
        }
        setError(describeReenrolError(caught));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
    // `onDone` is read when a round starts; only a new round asks for a new key.
  }, [round]);

  const newKey = (banner: string | null) => {
    setKey(null);
    setRound((r) => ({ n: r.n + 1, banner }));
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (key === null) return;
    setError(null);
    setBusy(true);
    reenrolApi
      .complete(code)
      .then((result) => {
        setRecovery({ codes: result.recoveryCodes, at: new Date(result.createdAt) });
        setBusy(false);
      })
      .catch((caught: unknown) => {
        setBusy(false);
        setCode('');
        if (isReenrolKeyGone(caught)) {
          newKey(REENROL_EXPIRED_MESSAGE);
          return;
        }
        if (isReenrolDone(caught)) {
          void onDone();
          return;
        }
        setError(describeReenrolError(caught));
      });
  };

  return (
    <EntryShell wide>
      <EntryHeading title={REENROL_TITLE}>{recovery === null ? REENROL_DESCRIPTION : 'Save your new recovery codes.'}</EntryHeading>
      <div className="pr-entry__body">
        {error === null ? null : (
          <Alert tone={error === REENROL_EXPIRED_MESSAGE ? 'warning' : 'danger'} title="Your new authenticator isn’t set up yet" dynamic>
            {error}
          </Alert>
        )}
        {recovery !== null ? (
          <Stack gap="16">
            <p>
              Your new authenticator works. The old one and your old recovery codes have stopped working, so save
              this new set.
            </p>
            <RecoveryCodes
              codes={recovery.codes}
              address={key?.address ?? null}
              createdAt={recovery.at}
              continueLabel={REENROL_CONTINUE_LABEL}
              onContinue={() => {
                setBusy(true);
                void Promise.resolve(onDone()).finally(() => {
                  setBusy(false);
                });
              }}
              busy={busy}
            />
          </Stack>
        ) : key === null ? (
          busy ? (
            <Spinner label="Making a new key" />
          ) : (
            <FormActions layout="stack">
              <Button
                type="button"
                variant="primary"
                onClick={() => {
                  newKey(null);
                }}
              >
                Try again
              </Button>
            </FormActions>
          )
        ) : (
          <Stack as="form" gap="16" onSubmit={submit} aria-label="Set up a new authenticator">
            <p>
              Scan this code with your authenticator app, then enter the six-digit code it shows. Can’t scan it?
              Type the key by hand, or open the link on this phone.
            </p>
            <TotpQr uri={key.otpauthUri} />
            <DescriptionList>
              <DescriptionItem term="Setup key">
                <Cluster gap="8" align="center">
                  <code className="pr-totp-key" data-testid="totp-secret">
                    {keyGroups(key.secret).map((group, i) => (
                      <span key={String(i)}>{group}</span>
                    ))}
                  </code>
                  <CopyButton value={key.secret} label="setup key" />
                </Cluster>
              </DescriptionItem>
              <DescriptionItem term="Authenticator link">
                <Link href={key.otpauthUri} variant="inline" data-testid="totp-uri">
                  Open in authenticator
                </Link>
              </DescriptionItem>
            </DescriptionList>
            <FormField label="Authentication code" help="Six digits from your new authenticator.">
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
                {REENROL_SUBMIT_LABEL}
              </Button>
            </FormActions>
          </Stack>
        )}
      </div>
    </EntryShell>
  );
}
