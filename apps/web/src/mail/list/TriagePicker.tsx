// PST-T-14.5: where v (Move) and b (Snooze) ask "to where?" / "until when?" — one small dialog,
// opened from the key, a row's actions or the selection toolbar. Move was only reachable through
// the command palette before (audit TF-05). Choosing closes it and runs the triage; Escape cancels.
import { Button, Modal } from '@d3cloud/ui';
import type { Mailbox } from '../../api';
import { snoozeChoices } from '../compose';
import { mailboxLabel } from '../format';
import { mailboxIcon } from '../icons';

export type PickerMode = 'move' | 'snooze';

export interface TriagePickerProps {
  mode: PickerMode | null;
  /** "this message", "3 messages", "this conversation". */
  what: string;
  mailboxes: readonly Mailbox[];
  /** The mailbox the messages are in now — not offered as a destination. */
  currentMailboxId: string | null;
  onMove: (to: Mailbox) => void;
  onSnooze: (until: Date, label: string) => void;
  onClose: () => void;
}

/** Destinations for Move: every mailbox but the one it is in, and not Drafts (a draft is made, not filed). */
export function moveTargets(mailboxes: readonly Mailbox[], currentMailboxId: string | null): Mailbox[] {
  return mailboxes.filter((m) => m.id !== currentMailboxId && m.specialUse !== 'drafts' && m.name !== 'Snoozed');
}

export function TriagePicker({ mode, what, mailboxes, currentMailboxId, onMove, onSnooze, onClose }: TriagePickerProps) {
  const open = mode !== null;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="sm"
      title={mode === 'snooze' ? 'Snooze until' : 'Move to'}
      description={mode === 'snooze' ? `It leaves the Inbox and comes back then: ${what}.` : `Files ${what} in another mailbox. You can undo it.`}
    >
      {mode === 'snooze' ? (
        <ul className="pr-picker">
          {snoozeChoices(new Date()).map((c) => (
            <li key={c.label}>
              <Button
                variant="ghost"
                className="pr-picker__item"
                onClick={() => {
                  onSnooze(c.until, c.label);
                }}
              >
                {c.label}
                <span className="pr-picker__hint">{c.until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : mode === 'move' ? (
        <ul className="pr-picker">
          {moveTargets(mailboxes, currentMailboxId).map((m) => (
            <li key={m.id}>
              <Button
                variant="ghost"
                className="pr-picker__item"
                icon={<span className="pr-picker__icon">{mailboxIcon(m.specialUse, m.name)}</span>}
                onClick={() => {
                  onMove(m);
                }}
              >
                {mailboxLabel(m)}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}
