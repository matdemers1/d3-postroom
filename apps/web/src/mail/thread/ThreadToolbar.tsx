// The reading toolbar (PST-T-14.6; design audit VIS-06, MOD-I4, INT-I7), drawn to the redesign
// canvas in PST-T-15.3: one 52px row of ghost icon buttons — Archive, Delete, Move, Snooze — each
// with an accessible name AND a visible tooltip naming its key; then the open message's place in
// the list ("3 of 48") with up/down to its neighbours (k/j); then ⋯ for the rare ones: Mark unread,
// Star, Inspect message (i), Show original, Print. Reply, Reply all and Forward left the toolbar for
// the message header and the quick-reply bar under the thread. Junk, Rejected and Drafts still lead
// with the one labelled move that is the point of that mailbox: Not junk, Rescue, Edit draft.
//
// Inspect stays the modal drawer it always was (InspectDrawer: focus trap, Escape, `i`); only its
// trigger moved. The ⋯ item and a chip's "Details" call keys.ts's requestInspect(), which the open
// message's drawer listens for, naming the button that focus goes back to when it closes.
//
// A dialog opened from a menu item (Inspect) is opened only once the menu has closed: the menu hands
// focus back to ⋯ as it goes, and a dialog already open would be fighting it for focus. Move is a
// controlled Modal with no trigger; focus returns to the Move button explicitly (../focusReturn.ts).
//
// Two library components cannot nest: Tooltip and MenuTrigger both wrap their one child with a
// Radix Slot and neither forwards props, so an icon button that opens a menu (⋯, Snooze) gets
// HintTip — the same look as the library tooltip, shown by CSS on :hover and :focus-visible, and
// aria-hidden because the button's own label already names it.
import { useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, ModalClose, Tooltip } from '@d3cloud/ui';
import { api, rawMessageUrl, type Mailbox, type MessageDetail } from '../../api';
import { snoozeChoices } from '../compose';
import { mailboxLabel } from '../format';
import { useFocusReturn } from '../focusReturn';
import { requestInspect } from '../keys';
import { isStarred } from '../list';
import { useMail } from '../MailContext';
import { attemptSnooze } from '../Scheduled';
import { ArchiveIcon, ChevronDownIcon, ChevronUpIcon, ClockIcon, MoreIcon, MoveIcon, TrashIcon } from './icons';
import { ACTION_KEY, ACTION_LABEL, positionLabel, positionMoves, readingToolbar, tooltipText, type ListPosition, type TriageAction } from './view';

export type ToolbarAction = 'reply' | 'replyAll' | 'forward' | 'archive' | 'delete' | 'markUnread' | 'star' | 'next' | 'prev';

export interface ThreadToolbarProps {
  detail: MessageDetail;
  canArchive: boolean;
  canTrash: boolean;
  onAction: (action: ToolbarAction) => void;
  /** Moves the open message to another mailbox — Not junk, Rescue and Move (absent: hidden). */
  onMoveTo?: ((message: MessageDetail, to: Mailbox) => void) | undefined;
  /** Opens a draft in the composer (absent: Drafts has no Edit draft to lead with). */
  onEditDraft?: ((message: MessageDetail) => void) | undefined;
  /** The Snooze control, rendered in the triage group where snoozing makes sense. */
  snooze?: ReactNode;
  /** The open message's place in the list it was opened from ("3 of 48"); absent or off-list: hidden. */
  position?: ListPosition | null | undefined;
}

/** A tooltip for an icon button that is also a menu trigger (see the header comment). */
export function HintTip({ text, align, children }: { text: string; align?: 'end'; children: ReactNode }) {
  return (
    <span className="pr-hint" data-align={align}>
      {children}
      <span className="pr-hint__tip" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

const TRIAGE_ICON: Record<TriageAction, ReactNode> = { archive: <ArchiveIcon />, delete: <TrashIcon /> };

export function ThreadToolbar({ detail, canArchive, canTrash, onAction, onMoveTo, onEditDraft, snooze, position }: ThreadToolbarProps) {
  const { mailboxes } = useMail();
  const current = mailboxes?.find((m) => m.id === detail.mailboxId) ?? null;
  const inbox = mailboxes?.find((m) => m.specialUse === 'inbox' || m.name.toUpperCase() === 'INBOX') ?? null;
  const model = readingToolbar(current?.specialUse);
  const starred = isStarred(detail);
  const [moveOpen, setMoveOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const moveReturn = useFocusReturn(moveOpen, () => moveRef.current);
  const where = positionLabel(position);
  const moves = positionMoves(position);

  let lead: ReactNode = null;
  if ((model.lead === 'notJunk' || model.lead === 'rescue') && onMoveTo !== undefined && inbox !== null) {
    lead = (
      <Button size="sm" variant="primary" onClick={() => { onMoveTo(detail, inbox); }}>
        {ACTION_LABEL[model.lead]}
      </Button>
    );
  } else if (model.lead === 'editDraft' && onEditDraft !== undefined) {
    lead = (
      <Button size="sm" variant="primary" onClick={() => { onEditDraft(detail); }}>
        {ACTION_LABEL.editDraft}
      </Button>
    );
  }

  const targets = (mailboxes ?? []).filter((m) => m.id !== detail.mailboxId && m.specialUse !== 'drafts' && m.specialUse !== 'sent' && m.name !== 'Snoozed');
  const canMove = onMoveTo !== undefined && targets.length > 0;

  return (
    <div role="toolbar" aria-label="Message actions" className="pr-toolbar" data-lead={model.lead ?? 'none'}>
      <div className="pr-toolbar__group">
        {lead}
        {model.triage.map((a) => (
          <Tooltip key={a} side="bottom" content={tooltipText(ACTION_LABEL[a], ACTION_KEY[a])}>
            <IconButton
              size="md"
              variant="ghost"
              label={ACTION_LABEL[a]}
              aria-keyshortcuts={ACTION_KEY[a]}
              icon={TRIAGE_ICON[a]}
              disabled={a === 'archive' ? !canArchive : !canTrash}
              onClick={() => { onAction(a); }}
            />
          </Tooltip>
        ))}
        {canMove ? (
          <Tooltip side="bottom" content={tooltipText(ACTION_LABEL.move, ACTION_KEY.move)}>
            <IconButton
              ref={moveRef}
              size="md"
              variant="ghost"
              label={ACTION_LABEL.move}
              icon={<MoveIcon />}
              aria-haspopup="dialog"
              onClick={() => {
                moveReturn.current = moveRef.current;
                setMoveOpen(true);
              }}
            />
          </Tooltip>
        ) : null}
        {model.snooze ? snooze : null}
      </div>
      <span className="pr-toolbar__spacer" />
      {where === null ? null : (
        <div className="pr-toolbar__group pr-toolbar__nav">
          <span className="pr-toolbar__pos" data-testid="list-position">
            {where}
          </span>
          <Tooltip side="bottom" content={tooltipText(ACTION_LABEL.prev, ACTION_KEY.prev)}>
            <IconButton size="md" variant="ghost" label={ACTION_LABEL.prev} aria-keyshortcuts={ACTION_KEY.prev} icon={<ChevronUpIcon />} disabled={!moves.prev} onClick={() => { onAction('prev'); }} />
          </Tooltip>
          <Tooltip side="bottom" content={tooltipText(ACTION_LABEL.next, ACTION_KEY.next)}>
            <IconButton size="md" variant="ghost" label={ACTION_LABEL.next} aria-keyshortcuts={ACTION_KEY.next} icon={<ChevronDownIcon />} disabled={!moves.next} onClick={() => { onAction('next'); }} />
          </Tooltip>
          <span className="pr-toolbar__divider" aria-hidden="true" />
        </div>
      )}
      <Menu>
        <HintTip text="More actions" align="end">
          <MenuTrigger>
            <IconButton ref={moreRef} size="md" variant="ghost" label="More actions" icon={<MoreIcon />} />
          </MenuTrigger>
        </HintTip>
        <MenuContent align="end">
          <MenuItem onSelect={() => { onAction('markUnread'); }}>
            <MenuRow label="Mark unread" hint={ACTION_KEY.markUnread} />
          </MenuItem>
          <MenuItem onSelect={() => { onAction('star'); }}>
            <MenuRow label={starred ? 'Unstar' : 'Star'} hint={ACTION_KEY.star} />
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              afterMenu(() => {
                requestInspect(moreRef.current);
              });
            }}
          >
            <MenuRow label="Inspect message" hint={ACTION_KEY.inspect} />
          </MenuItem>
          <MenuItem asChild>
            <a href={rawMessageUrl(detail.id)} download>
              Show original
            </a>
          </MenuItem>
          <MenuItem
            onSelect={() => {
              window.print();
            }}
          >
            Print
          </MenuItem>
        </MenuContent>
      </Menu>
      {canMove ? (
        <Modal
          open={moveOpen}
          onOpenChange={setMoveOpen}
          title="Move to"
          description="Choose where this message goes."
          size="sm"
          footer={
            <ModalClose>
              <Button type="button">Cancel</Button>
            </ModalClose>
          }
        >
          <ul className="pr-moveto" aria-label="Mailboxes">
            {targets.map((m) => (
              <li key={m.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="pr-moveto__btn"
                  onClick={() => {
                    setMoveOpen(false);
                    onMoveTo(detail, m);
                  }}
                >
                  {mailboxLabel(m)}
                </Button>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </div>
  );
}

/** Runs `open` once the menu that chose it has closed and handed focus back to its trigger. */
export function afterMenu(open: () => void): void {
  window.setTimeout(open, 0);
}

/** A menu row: the action's words, then its key — hidden from the accessible name, which is the action. */
function MenuRow({ label, hint }: { label: string; hint: string | undefined }) {
  return (
    <span className="pr-menurow">
      <span>{label}</span>
      {hint === undefined ? null : (
        <kbd className="pr-menurow__key" aria-hidden="true">
          {hint}
        </kbd>
      )}
    </span>
  );
}

/**
 * Snooze as an icon button with a menu of times (PST-T-9.1, PST-REQ-142), or Unsnooze for a snoozed
 * conversation — the same behaviour as Scheduled.tsx's SnoozeControl, drawn for the icon group.
 */
export function SnoozeIconControl({ threadId, snoozed, inInbox, onDone }: { threadId: string | null; snoozed: boolean; inInbox: boolean; onDone: (text: string) => void }) {
  const { refreshMailboxes } = useMail();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (threadId === null || (!snoozed && !inInbox)) return null;

  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    const outcome = await attemptSnooze(f, done);
    setBusy(false);
    if (outcome.ok) {
      void refreshMailboxes();
      onDone(outcome.text);
    } else setError(outcome.text);
  };

  const failure =
    error === null ? null : (
      <span className="pr-snooze__error" role="alert">
        {error}
      </span>
    );

  if (snoozed) {
    return (
      <span className="pr-snooze">
        <Tooltip side="bottom" content="Unsnooze">
          <IconButton size="md" variant="ghost" label="Unsnooze" icon={<ClockIcon />} loading={busy} onClick={() => void run(() => api.unsnoozeThread(threadId), 'Back in Inbox.')} />
        </Tooltip>
        {failure}
      </span>
    );
  }
  return (
    <span className="pr-snooze">
      <Menu>
        <HintTip text="Snooze">
          <MenuTrigger>
            <IconButton size="md" variant="ghost" label="Snooze" icon={<ClockIcon />} loading={busy} />
          </MenuTrigger>
        </HintTip>
        <MenuContent aria-label="Snooze until">
          {snoozeChoices(new Date()).map((c) => (
            <MenuItem
              key={c.label}
              onSelect={() => {
                void run(() => api.snoozeThread(threadId, c.until.toISOString()), `Snoozed until ${c.until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`);
              }}
            >
              {c.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {failure}
    </span>
  );
}
