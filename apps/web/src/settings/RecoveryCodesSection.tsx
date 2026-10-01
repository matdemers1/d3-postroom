import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, FormField, Input, Modal, ModalClose, Section, Stack } from '@d3cloud/ui';
import { ApiError, api, describeError } from '../api';
import { recoveryApi, type RecoveryStatus } from '../screens/recovery/api';
import { RecoveryCodes } from '../screens/recovery/RecoveryCodes';
import { recoveryStatusLine } from './recovery-status';

/**
 * Recovery codes on Security & devices (PST-T-16.7, PST-REQ-197): how many of the set are left, and
 * a new set. Making one is destructive — the old codes stop working in the same commit — so it
 * needs a TOTP code from the last five minutes: the server answers 403 step_up_required, the code
 * prompt opens, and the request is retried once the code is accepted. The new codes are shown here
 * once, behind the same "I have saved these" checkbox as at setup.
 */
export function RecoveryCodesSection() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ codes: string[]; at: Date } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await recoveryApi.status());
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const regenerate = async (): Promise<void> => {
    setNotice(null);
    try {
      const result = await recoveryApi.regenerate();
      setConfirming(false);
      setStepUp(false);
      setFresh({ codes: result.recoveryCodes, at: new Date(result.createdAt) });
      await load();
    } catch (caught) {
      setConfirming(false);
      if (caught instanceof ApiError && caught.code === 'step_up_required') {
        setCode('');
        setCodeError(null);
        setStepUp(true);
        return;
      }
      setStepUp(false);
      setNotice(describeError(caught));
    }
  };

  const confirmStepUp = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setCodeError(null);
    api
      .stepUp(code)
      .then(() => regenerate())
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Section
      title="Recovery codes"
      description="For signing in when your authenticator isn’t with you. Each code works once."
      actions={
        fresh === null ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Make new codes
          </Button>
        ) : null
      }
    >
      <Stack gap="16">
        {notice === null ? null : (
          <Alert tone="danger" dynamic>
            {notice}
          </Alert>
        )}
        {fresh !== null ? (
          <RecoveryCodes
            codes={fresh.codes}
            createdAt={fresh.at}
            continueLabel="Done"
            onContinue={() => {
              setFresh(null);
              setNotice(null);
            }}
          />
        ) : loadError !== null ? (
          <Alert tone="danger" actions={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
            {describeError(loadError)}
          </Alert>
        ) : (
          <p data-testid="recovery-status">{status === null ? 'Loading…' : recoveryStatusLine(status)}</p>
        )}
      </Stack>

      <Modal
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        destructive
        title="Make new recovery codes?"
        description="Your current codes stop working as soon as the new ones are made."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                void regenerate();
              }}
            >
              Make new codes
            </Button>
          </>
        }
      >
        {null}
      </Modal>

      <Modal
        open={stepUp}
        onOpenChange={(open) => {
          if (!open) setStepUp(false);
        }}
        title="Confirm it is you"
        description="New recovery codes replace the old ones. Enter a code from your authenticator; it stays valid for five minutes."
        footer={
          <>
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
            <Button type="submit" form="recovery-step-up" variant="danger" loading={busy}>
              Verify and make new codes
            </Button>
          </>
        }
      >
        <form id="recovery-step-up" onSubmit={confirmStepUp}>
          <FormField label="Authentication code" {...(codeError === null ? {} : { error: codeError })}>
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
        </form>
      </Modal>
    </Section>
  );
}
