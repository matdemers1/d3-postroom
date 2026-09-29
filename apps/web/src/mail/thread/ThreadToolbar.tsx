// The reading toolbar (PST-T-14.6; design audit VIS-06, MOD-I4, INT-I7). Nine equal text buttons
// became: one lead (Reply, or Not junk / Rescue / Edit draft where that is the point of the mailbox),
// the two triage moves labelled (Archive, Delete), the replies and Snooze as icon buttons — each
// with an accessible name AND a visible tooltip on hover and focus — and a ⋯ menu for the rare ones:
// Move to…, Mark unread, Star, Inspect message (i), Show original, Print.
//
// Inspect stays the modal drawer it always was (InspectDrawer: focus trap, Escape, `i`); only its
// trigger moved. The ⋯ item and a chip's "Details" call keys.ts's requestInspect(), which the open
// message's drawer listens for, naming the button that focus goes back to when it closes.
//
// A dialog opened from a menu item (Inspect, Move to…) is opened only once the menu has closed: the
// menu hands focus back to ⋯ as it goes, and a dialog already open would be fighting it for focus.
// Move to… is a controlled Modal with no trigger; focus returns to ⋯ explicitly (../focusReturn.ts).
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
import { ClockIcon, ForwardIcon, MoreIcon, ReplyAllIcon, ReplyIcon } from './icons';
import { ACTION_KEY, ACTION_LABEL, toolbarModel, tooltipText, type IconAction } from './view';

export type ToolbarAction = 'reply' | 'replyAll' | 'forward' | 'archive' | 'delete' | 'markUnread' | 'star';

export interface ThreadToolbarProps {
  detail: MessageDetail;
  canArchive: boolean;
  canTrash: boolean;
  onAction: (action: ToolbarAction) => void;
  /** Moves the open message to another mailbox — Not junk, Rescue and Move to… (absent: hidden). */
  onMoveTo?: ((message: MessageDetail, to: Mailbox) => void) | undefined;
  /** Opens a draft in the composer (absent: Drafts has no Edit draft to lead with). */
  onEditDraft?: ((message: MessageDetail) => void) | undefined;
  /** The Snooze control, rendered in the icon group where snoozing makes sense. */
  snooze?: ReactNode;
}

/** A tooltip for an icon button that is also a menu trigger (see the header comment). */
export function HintTip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="pr-hint">
      {children}
      <span className="pr-hint__tip" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

const ICON: Record<IconAction, ReactNode> = { reply: <ReplyIcon />, replyAll: <ReplyAllIcon />, forward: <ForwardIcon /> };

export function ThreadToolbar({ detail, canArchive, canTrash, onAction, onMoveTo, onEditDraft, snooze }: ThreadToolbarProps) {
  const { mailboxes } = useMail();
  const current = mailboxes?.find((m) => m.id === detail.mailboxId) ?? null;
  const inbox = mailboxes?.find((m) => m.specialUse === 'inbox' || m.name.toUpperCase() === 'INBOX') ?? null;
  const model = toolbarModel(current?.specialUse);
  const starred = isStarred(detail);
  const [moveOpen, setMoveOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moveReturn = useFocusReturn(moveOpen, () => moreRef.current);

  let lead: ReactNode = null;
  if (model.lead === 'reply') {
    lead = (
      <Button size="sm" variant="primary" aria-keyshortcuts="r" onClick={() => { onAction('reply'); }}>
        {ACTION_LABEL.reply}
      </Button>
    );
  } else if ((model.lead === 'notJunk' || model.lead === 'rescue') && onMoveTo !== undefined && inbox !== null) {
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

  return (
    <div role="toolbar" aria-label="Message actions" className="pr-toolbar" data-lead={model.lead ?? 'none'}>
      <div className="pr-toolbar__group">
        {lead}
        {model.labelled.map((a) => (
          <Button
            key={a}
            size="sm"
            variant="ghost"
            aria-keyshortcuts={a === 'archive' ? 'e' : '#'}
            disabled={a === 'archive' ? !canArchive : !canTrash}
            onClick={() => { onAction(a); }}
          >
            {ACTION_LABEL[a]}
          </Button>
        ))}
      </div>
      <div className="pr-toolbar__group pr-toolbar__group--icons">
        {model.icons.map((a) => (
          <Tooltip key={a} content={tooltipText(ACTION_LABEL[a], ACTION_KEY[a])}>
            <IconButton size="sm" variant="ghost" label={ACTION_LABEL[a]} aria-keyshortcuts={ACTION_KEY[a]} icon={ICON[a]} onClick={() => { onAction(a); }} />
          </Tooltip>
        ))}
        {model.snooze ? snooze : null}
        <Menu>
          <HintTip text="More actions">
            <MenuTrigger>
              <IconButton ref={moreRef} size="sm" variant="ghost" label="More actions" icon={<MoreIcon />} />
            </MenuTrigger>
          </HintTip>
          <MenuContent align="end">
            {onMoveTo !== undefined && targets.length > 0 ? (
              <MenuItem
                onSelect={() => {
                  afterMenu(() => {
                    moveReturn.current = moreRef.current;
                    setMoveOpen(true);
                  });
                }}
              >
                Move to…
              </MenuItem>
            ) : null}
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
      </div>
      {onMoveTo !== undefined ? (
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
        <Tooltip content="Unsnooze">
          <IconButton size="sm" variant="ghost" label="Unsnooze" icon={<ClockIcon />} loading={busy} onClick={() => void run(() => api.unsnoozeThread(threadId), 'Back in Inbox.')} />
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
            <IconButton size="sm" variant="ghost" label="Snooze" icon={<ClockIcon />} loading={busy} />
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
