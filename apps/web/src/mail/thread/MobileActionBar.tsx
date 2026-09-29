// PST-T-14.8 (PST-REQ-155, PST-ADR-011; design audit RSP-01, IA-15, TF-04): at phone width the
// thread shows its body first and the actions sit in a sticky bar at the bottom, in thumb reach from
// anywhere in a long thread — Archive, Delete, Move, Reply, and ⋯ for Reply all, Forward, Snooze,
// Mark unread, Star and Inspect. Every target is a real 44 px box (52 px tall, the label under the
// icon). No swipe gestures.
//
// It forks no action logic: every button is a MailAction handed to MailView's perform() — the same
// path as the keys, the palette and the desktop toolbar — so Archive and Delete run the triage loop
// (thread scope, next message, Undo toast), Move and Snooze open its picker, and Inspect is
// keys.ts's requestInspect(). Which buttons a mailbox gets is ThreadToolbar's own toolbarModel().
import type { ReactNode } from 'react';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@d3cloud/ui';
import type { Mailbox, MessageDetail } from '../../api';
import { ArchiveIcon, FolderIcon, TrashIcon } from '../icons';
import { requestInspect, type MailAction } from '../keys';
import { isStarred } from '../list';
import { useMail } from '../MailContext';
import { MoreIcon, ReplyIcon } from './icons';
import { ACTION_LABEL, toolbarModel } from './view';

export interface MobileActionBarProps {
  detail: MessageDetail;
  canArchive: boolean;
  canTrash: boolean;
  /** MailView's perform(): the one place a mail action is carried out. */
  onAction: (action: MailAction) => void;
  /** Not junk / Rescue: the open message back to the Inbox (through triage). */
  onMoveTo?: ((message: MessageDetail, to: Mailbox) => void) | undefined;
}

function BarButton({ label, icon, disabled = false, onClick }: { label: string; icon: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="pr-abar__btn" disabled={disabled} onClick={onClick}>
      <span className="pr-abar__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="pr-abar__label">{label}</span>
    </button>
  );
}

export function MobileActionBar({ detail, canArchive, canTrash, onAction, onMoveTo }: MobileActionBarProps) {
  const { mailboxes } = useMail();
  const current = mailboxes?.find((m) => m.id === detail.mailboxId) ?? null;
  const inbox = mailboxes?.find((m) => m.specialUse === 'inbox' || m.name.toUpperCase() === 'INBOX') ?? null;
  const model = toolbarModel(current?.specialUse);
  const starred = isStarred(detail);
  const canReply = model.lead === 'reply' || model.icons.includes('reply');
  const rescue = (model.lead === 'notJunk' || model.lead === 'rescue') && onMoveTo !== undefined && inbox !== null ? model.lead : null;

  return (
    <div role="toolbar" aria-label="Message actions" className="pr-abar" data-testid="action-bar">
      {model.labelled.includes('archive') ? <BarButton label={ACTION_LABEL.archive} icon={<ArchiveIcon />} disabled={!canArchive} onClick={() => { onAction('archive'); }} /> : null}
      <BarButton label={ACTION_LABEL.delete} icon={<TrashIcon />} disabled={!canTrash} onClick={() => { onAction('delete'); }} />
      <BarButton label="Move" icon={<FolderIcon />} onClick={() => { onAction('moveTo'); }} />
      {rescue !== null && inbox !== null && onMoveTo !== undefined ? (
        <BarButton label={ACTION_LABEL[rescue]} icon={<ArchiveIcon />} onClick={() => { onMoveTo(detail, inbox); }} />
      ) : canReply ? (
        <BarButton label={ACTION_LABEL.reply} icon={<ReplyIcon />} onClick={() => { onAction('reply'); }} />
      ) : null}
      <Menu>
        <MenuTrigger>
          <button type="button" className="pr-abar__btn" aria-label="More actions">
            <span className="pr-abar__icon" aria-hidden="true">
              <MoreIcon />
            </span>
            <span className="pr-abar__label" aria-hidden="true">
              More
            </span>
          </button>
        </MenuTrigger>
        <MenuContent align="end" side="top" className="pr-abar__menu">
          {canReply ? (
            <>
              <MenuItem onSelect={() => { onAction('replyAll'); }}>{ACTION_LABEL.replyAll}</MenuItem>
              <MenuItem onSelect={() => { onAction('forward'); }}>{ACTION_LABEL.forward}</MenuItem>
            </>
          ) : null}
          {model.snooze ? <MenuItem onSelect={() => { onAction('snooze'); }}>Snooze…</MenuItem> : null}
          <MenuItem onSelect={() => { onAction('markUnread'); }}>Mark unread</MenuItem>
          <MenuItem onSelect={() => { onAction('star'); }}>{starred ? 'Unstar' : 'Star'}</MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => { requestInspect(); }}>Inspect message</MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
