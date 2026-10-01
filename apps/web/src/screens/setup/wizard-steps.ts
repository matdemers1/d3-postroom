// PST-T-17.14 (PST-REQ-194; admin critique 2.9 #1, #4, #5): the setup wizard's stepper, as data. Each
// step is done or still to do (the server's furthest step decides), and exactly one is the step on
// screen. Pure, so the stepper's states are tested without a browser.
import { WIZARD_STEPS, wizardReachable, wizardStepsLeft, type WizardStep, type WizardView } from '../../api';

export type ShownStep = Exclude<WizardStep, 'done'>;

/** What the stepper draws: the current step wins over done, and done over to do. */
export type StepState = 'done' | 'current' | 'todo';

export interface StepItem {
  step: ShownStep;
  label: string;
  /** 1-based. */
  number: number;
  state: StepState;
  /** Finished on the server, whether or not it is the step on screen (a revisited step keeps its ✓). */
  done: boolean;
  /** The step on screen: `aria-current="step"`. */
  current: boolean;
  /** Can be opened: it is the furthest step reached, or before it. */
  reachable: boolean;
}

/** The step whose card is on screen: once everything is done, the last one (the test and its timeline). */
export function shownStep(current: WizardStep): ShownStep {
  return current === 'done' ? 'test' : current;
}

/** How many steps are finished: every step before the furthest one reached, or all of them once complete. */
export function stepsDone(view: WizardView): number {
  return WIZARD_STEPS.length - wizardStepsLeft(view);
}

export function stepItems(view: WizardView, current: WizardStep): StepItem[] {
  const shown = shownStep(current);
  const done = stepsDone(view);
  return WIZARD_STEPS.map((s, i) => {
    const isDone = i < done;
    const isCurrent = s.step === shown;
    return {
      step: s.step,
      label: s.label,
      number: i + 1,
      state: isCurrent ? 'current' : isDone ? 'done' : 'todo',
      done: isDone,
      current: isCurrent,
      reachable: wizardReachable(view, s.step),
    };
  });
}

/** "2 of 5 done"; "All 5 done" once the wizard is complete. */
export function doneLabel(view: WizardView): string {
  const total = WIZARD_STEPS.length;
  const done = stepsDone(view);
  return done === total ? `All ${String(total)} done` : `${String(done)} of ${String(total)} done`;
}

/** "Step 3 of 5 · DNS records": the phone's one-line stepper. */
export function positionLabel(current: WizardStep): string {
  const shown = shownStep(current);
  const index = WIZARD_STEPS.findIndex((s) => s.step === shown);
  return `Step ${String(index + 1)} of ${String(WIZARD_STEPS.length)} · ${WIZARD_STEPS[index]?.label ?? ''}`;
}

/**
 * A step's accessible name: "1. Domain", then its state in words, since the circle that shows it is
 * decoration. The current step says nothing more: `aria-current="step"` already announces it.
 */
export function stepName(item: StepItem): string {
  const base = `${String(item.number)}. ${item.label}`;
  if (item.done) return `${base}, done`;
  if (!item.reachable) return `${base}, not reached yet`;
  return base;
}
