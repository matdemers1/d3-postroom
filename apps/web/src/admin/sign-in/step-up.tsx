// PST-T-17.7: the step-up the D3 Auth writes share — the same contract as Device setup and the
// Sign-in sessions screen. The action runs; a 403 step_up_required opens "Confirm it is you", and
// once the code is accepted the action runs again. Cancelling settles it with null.
import { type ReactElement, type SyntheticEvent, useCallback, useId, useRef, useState } from 'react';
import { Button, FormField, Input, Modal, ModalClose } from '@d3cloud/ui';
import { ApiError, api, describeError } from '../../api';

interface Pending {
  action: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export type WithStepUp = <T>(action: () => Promise<T>) => Promise<T | null>;

/** `why` finishes "… so it needs a code from your authenticator." in the prompt. */
export function useStepUp(why: string): { withStepUp: WithStepUp; prompt: ReactElement } {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const pending = useRef<Pending | null>(null);
  const formId = useId();

  const withStepUp: WithStepUp = useCallback(
    <T,>(action: () => Promise<T>): Promise<T | null> =>
      action().catch((caught: unknown) => {
        if (!(caught instanceof ApiError && caught.code === 'step_up_required')) throw caught;
        return new Promise<T | null>((resolve, reject) => {
          pending.current?.resolve(null);
          pending.current = { action, resolve: resolve as (value: unknown) => void, reject };
          setCode('');
          setCodeError(null);
          setOpen(true);
        });
      }),
    [],
  );

  const cancel = () => {
    setOpen(false);
    pending.current?.resolve(null);
    pending.current = null;
  };

  const confirm = (event: SyntheticEvent) => {
    event.preventDefault();
    setVerifying(true);
    setCodeError(null);
    api
      .stepUp(code.replace(/\s+/g, ''))
      .then(() => {
        const next = pending.current;
        pending.current = null;
        setOpen(false);
        if (next !== null) void next.action().then(next.resolve, next.reject);
      })
      .catch((caught: unknown) => {
        setCode('');
        setCodeError(describeError(caught));
      })
      .finally(() => {
        setVerifying(false);
      });
  };

  const prompt = (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      title="Confirm it is you"
      description={`${why}, so it needs a code from your authenticator. It stays valid for five minutes.`}
      footer={
        <>
          <ModalClose>
            <Button type="button">Cancel</Button>
          </ModalClose>
          <Button type="submit" form={formId} variant="primary" loading={verifying}>
            Verify
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={confirm}>
        <FormField label="Authentication code" width="sm" {...(codeError === null ? {} : { error: codeError })}>
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
  );

  return { withStepUp, prompt };
}
