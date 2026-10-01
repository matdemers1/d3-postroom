import './account.css';
import { type SyntheticEvent, useCallback, useEffect, useId, useState } from 'react';
import { Alert, Button, FormField, Input, Modal, ModalClose, SettingsRow, StatusDot } from '@d3cloud/ui';
import { ApiError, api, describeError } from '../api';
import { recoveryApi, type RecoveryStatus } from '../screens/recovery/api';
import { RecoveryCodes } from '../screens/recovery/RecoveryCodes';
import { recoveryStatusLine } from './recovery-status';

/** The row's title, and the name of the region that holds the row and a freshly made set. */
export const RECOVERY_TITLE = 'Recovery codes';

/**
 * Recovery codes, a row of Settings › Account › Sign-in (PST-T-16.7, PST-REQ-197; moved here from
 * Browser sessions by PST-T-17.12): how many of the set are left, and a new set. Making one is
 * destructive — the old codes stop working in the same commit — so it asks first, then needs a TOTP
 * code from the last five minutes: the server answers 403 step_up_required, the code prompt opens,
 * and the request is retried once the code is accepted. The new codes are shown here once, under
 * the row, behind the same "I have saved these" checkbox as at setup.
 *
 * The row sits in a `<section>` named by its title, so the row, its error and the new codes are one
 * region ("Recovery codes") inside the Sign-in card.
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
  const rowId = useId();
  const stepUpFormId = useId();

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

  // The right of the row: what to do next. While a new set is on screen, that is to save it.
  const control =
    fresh !== null ? (
      <StatusDot size="sm" tone="attention">
        Save the new codes
      </StatusDot>
    ) : loadError !== null ? (
      <Button variant="secondary" size="sm" onClick={() => void load()}>
        Try again
      </Button>
    ) : (
      <Button
        variant="secondary"
        size="sm"
        disabled={status === null}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Make new codes
      </Button>
    );

  return (
    <section className="pr-recovery" aria-labelledby={`${rowId}-title`}>
      <SettingsRow
        id={rowId}
        title={RECOVERY_TITLE}
        description={
          loadError !== null ? (
            <span role="alert">Couldn’t load your recovery codes. {describeError(loadError)}</span>
          ) : (
            <span data-testid="recovery-status">{status === null ? 'Loading…' : recoveryStatusLine(status)}</span>
          )
        }
        control={control}
      />
      {notice === null ? null : (
        <Alert tone="danger" title="Could not make new codes" dynamic>
          {notice}
        </Alert>
      )}
      {fresh === null ? null : (
        <div className="pr-recovery__fresh">
          <RecoveryCodes
            codes={fresh.codes}
            createdAt={fresh.at}
            continueLabel="Done"
            onContinue={() => {
              setFresh(null);
              setNotice(null);
            }}
          />
        </div>
      )}

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
            <Button type="submit" form={stepUpFormId} variant="danger" loading={busy}>
              Verify and make new codes
            </Button>
          </>
        }
      >
        <form id={stepUpFormId} onSubmit={confirmStepUp}>
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
    </section>
  );
}
