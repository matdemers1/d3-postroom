// PST-T-17.11: what the Rules & sorting page shows about the saved Sieve scripts. Pure, so the
// rules of the page (which card shows, which row offers what) are tested without rendering.
import type { SieveScriptSummary } from '../../api';

export type ScriptAction = 'edit' | 'delete';

/**
 * A script row's actions: Edit unless it is the one already open in the editor, Delete unless it is
 * the one running (the server refuses that with 409 script_active). One action is a button in the
 * row; two go behind ⋯.
 */
export function scriptActions(script: SieveScriptSummary, openName: string): ScriptAction[] {
  const actions: ScriptAction[] = [];
  if (script.name !== openName) actions.push('edit');
  if (!script.active) actions.push('delete');
  return actions;
}

/**
 * The Scripts card only renders when there is a script other than the one in the editor: with just
 * the one, the editor card already says everything (critique-settings 2.6 #2).
 */
export function showsScripts(scripts: readonly SieveScriptSummary[], openName: string): boolean {
  return scripts.some((s) => s.name !== openName);
}

/** The editor card's state, as a dot and a word: neutral when running, idle when not (D-016). */
export function runningState(script: SieveScriptSummary | null): { tone: 'neutral' | 'idle'; label: string } {
  return script?.active === true ? { tone: 'neutral', label: 'Running' } : { tone: 'idle', label: 'Not running' };
}

/**
 * One write at a time. The page's buttons are disabled while one runs, but a menu item, the form's
 * Enter, or a step-up still waiting in its modal must not start a second one either: `run` refuses
 * (returns null, and never calls `work`) until the one in flight settles, whether it resolved,
 * rejected or threw.
 */
export interface RunGuard {
  readonly running: boolean;
  run: (work: () => Promise<void>) => Promise<void> | null;
}

export function createRunGuard(): RunGuard {
  let running = false;
  return {
    get running() {
      return running;
    },
    run(work) {
      if (running) return null;
      running = true;
      // An async wrapper, so a work function that throws before its first await still releases.
      return (async () => {
        await work();
      })().finally(() => {
        running = false;
      });
    },
  };
}
