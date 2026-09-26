// The setup wizard's persisted state (PST-REQ-098): one `setting` row, so the operator can leave and
// resume on any device. The steps run in order; `step` is the furthest one reached, and revisiting
// an earlier step never moves it back.
import type { Db, Prisma } from '@postroom/db';
import { z } from 'zod';

export const SETTING_KEY = 'setup_wizard';

export const STEPS = ['domain', 'dkim', 'dns', 'mailbox', 'test', 'done'] as const;
export type Step = (typeof STEPS)[number];

export const WizardState = z.object({
  step: z.enum(STEPS),
  domain: z.string().nullable(),
  dnsAcknowledgedAt: z.string().nullable(),
  mailbox: z.string().nullable(),
  test: z.object({ outboundId: z.string(), to: z.array(z.string()), sentAt: z.string() }).nullable(),
  completedAt: z.string().nullable(),
});
export type WizardState = z.infer<typeof WizardState>;

export const INITIAL: WizardState = { step: 'domain', domain: null, dnsAcknowledgedAt: null, mailbox: null, test: null, completedAt: null };

export const stepIndex = (step: Step): number => STEPS.indexOf(step);

/** The furthest of two steps. */
export const furthest = (a: Step, b: Step): Step => (stepIndex(a) >= stepIndex(b) ? a : b);

/** Whether `step` may be submitted from `state`: every step before it is done. */
export function reachable(state: WizardState, step: Step): boolean {
  return stepIndex(step) <= stepIndex(state.step);
}

type Client = Db | Prisma.TransactionClient;

export async function loadState(db: Client): Promise<WizardState> {
  const row = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  if (row === null) return INITIAL;
  const parsed = WizardState.safeParse(row.value);
  // A row this version cannot read starts the wizard over rather than guessing.
  return parsed.success ? parsed.data : INITIAL;
}

export async function saveState(db: Client, state: WizardState): Promise<void> {
  const value = state as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value }, update: { value } });
}
