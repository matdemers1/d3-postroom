// PST-T-17.11: Import's step-up, behaviourally. "Start import" runs through the shared
// admin/sign-in/step-up.tsx hook: start → 403 step_up_required → "Confirm it is you" → the code is
// verified → start again, once. A cancelled prompt settles as `cancelled`, so the screen leaves the
// form alone. The unit environment is Node with no DOM, so the real hook is run once under
// react-dom/server (useState/useRef/useCallback work there; a state update after render is a no-op)
// and its `withStepUp` and prompt are captured; the prompt's own form submit and close are then
// called the way the Modal would.
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Props = Record<string, unknown> & { children?: ReactNode };

// The component library ships CSS, which Node cannot import: plain stand-ins.
vi.mock('@d3cloud/ui', () => {
  const pass = (p: Props) => createElement('div', null, p.children);
  return { Modal: pass, ModalClose: pass, Button: pass, FormField: pass, Input: () => null };
});

const stepUp = vi.fn<(code: string) => Promise<{ ok: true }>>();
vi.mock('../../src/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/api')>();
  return { ...real, api: { ...real.api, stepUp: (code: string) => stepUp(code) } };
});

const { ApiError } = await import('../../src/api');
const { useStepUp } = await import('../../src/admin/sign-in/step-up');
const { startImport } = await import('../../src/screens/import/start');
type ImportStatus = import('../../src/api').ImportStatus;

interface Captured {
  withStepUp: ReturnType<typeof useStepUp>['withStepUp'];
  prompt: ReactElement<{ onOpenChange: (open: boolean) => void; children: ReactElement<{ onSubmit: (e: { preventDefault: () => void }) => void }> }>;
}

function capture(): Captured {
  const got: Captured[] = [];
  function Probe() {
    got.push(useStepUp('Starting an import hands Postroom the password to another mailbox') as unknown as Captured);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const [first] = got;
  if (first === undefined) throw new Error('the hook did not run');
  return first;
}

const STARTED = { id: 'imp-1', status: 'pending' } as unknown as ImportStatus;
const needsStepUp = () => new ApiError(403, 'step_up_required', { error: 'step_up_required' });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Import’s step-up (PST-T-17.11)', () => {
  beforeEach(() => {
    stepUp.mockReset();
  });

  it('starts at once when no step-up is needed', async () => {
    const { withStepUp } = capture();
    const start = vi.fn(() => Promise.resolve(STARTED));
    await expect(startImport(withStepUp, start)).resolves.toEqual({ kind: 'started', import: STARTED });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('start → 403 → Confirm it is you → verify → start again, once', async () => {
    const { withStepUp, prompt } = capture();
    const calls: string[] = [];
    let first = true;
    const start = vi.fn(() => {
      calls.push('start');
      if (first) {
        first = false;
        return Promise.reject(needsStepUp());
      }
      return Promise.resolve(STARTED);
    });
    stepUp.mockImplementation((code) => {
      calls.push(`step-up:${code}`);
      return Promise.resolve({ ok: true });
    });

    const outcome = startImport(withStepUp, start);
    await tick();
    // Waiting on the prompt: one start so far, nothing verified.
    expect(calls).toEqual(['start']);
    // The prompt's form submits (the code typed into it is the hook's state; '' here).
    prompt.props.children.props.onSubmit({ preventDefault: () => undefined });
    await expect(outcome).resolves.toEqual({ kind: 'started', import: STARTED });
    expect(calls).toEqual(['start', 'step-up:', 'start']);
  });

  it('a cancelled prompt settles as cancelled, without a second start or a step-up', async () => {
    const { withStepUp, prompt } = capture();
    const start = vi.fn(() => Promise.reject(needsStepUp()));
    const outcome = startImport(withStepUp, start);
    await tick();
    prompt.props.onOpenChange(false);
    await expect(outcome).resolves.toEqual({ kind: 'cancelled' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('any other refusal is a failure the form shows', async () => {
    const { withStepUp } = capture();
    const refused = new ApiError(409, 'import_active', {});
    await expect(startImport(withStepUp, () => Promise.reject(refused))).resolves.toEqual({ kind: 'failed', error: refused });
  });
});
