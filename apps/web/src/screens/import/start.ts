// PST-T-17.11: starting an import through the step-up contract, apart from the screen so its
// outcomes are tested in Node. A 403 step_up_required opens "Confirm it is you" (the shared
// admin/sign-in/step-up.tsx hook); once the code is accepted the start runs again, once. A cancelled
// prompt settles as `cancelled` and the screen leaves the form exactly as it was.
import type { ImportStatus } from '../../api';
import type { WithStepUp } from '../../admin/sign-in/step-up';

export type StartOutcome = { kind: 'started'; import: ImportStatus } | { kind: 'cancelled' } | { kind: 'failed'; error: unknown };

export async function startImport(withStepUp: WithStepUp, start: () => Promise<ImportStatus>): Promise<StartOutcome> {
  try {
    const started = await withStepUp(start);
    return started === null ? { kind: 'cancelled' } : { kind: 'started', import: started };
  } catch (error) {
    return { kind: 'failed', error };
  }
}
