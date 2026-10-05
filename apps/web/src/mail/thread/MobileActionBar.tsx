// PST-T-14.8 (PST-REQ-155, PST-ADR-011; design audit RSP-01, IA-15, TF-04): at phone width the
// thread shows its body first and the actions sit in a sticky bar at the bottom, in thumb reach from
// anywhere in a long thread — Archive, Delete, Move, Reply, and ⋯ for Reply all, Forward, Snooze,
// Mark unread, Star and Inspect. The bar is for the open message; swiping is the list's (PST-T-16.15:
// a row dragged left archives, right toggles read, through the same triage path and Undo toast), an
// accelerator over buttons that remain for everyone.
//
// PST-T-15.8 (PST-REQ-194): drawn to the canvas's PhoneThread with @d3cloud/ui's ActionBar (D-083) —
// a labelled group of plain buttons in tab order, an icon over a word, never under 44 px, the home
// indicator's inset below. Reply is the bar's one accent. The library hides the bar from lg up;
// Postroom's phone layout ends at 768 px, and MailView only mounts this bar in that layout, so it is
// forced visible here.
//
// It forks no action logic: every button is a MailAction handed to MailView's perform() — the same
// path as the keys, the palette and the desktop toolbar — so Archive and Delete run the triage loop
// (thread scope, next message, Undo toast), Move and Snooze open its picker, and Inspect is
// keys.ts's requestInspect(). Which buttons a mailbox gets is ThreadToolbar's own toolbarModel().
import { useRef } from 'react';
import { CONSTELLATION_LABEL, onApple, openInConstellation } from '../../components/OpenInConstellation';
import { ActionBar, ActionBarItem, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@d3cloud/ui';
import type { Mailbox, MessageDetail } from '../../api';
import { ArchiveIcon, FolderIcon, TrashIcon } from '../icons';
import { requestInspect, type MailAction } from '../keys';
import { isStarred } from '../list';
import { useMail } from '../MailContext';
import { MoreIcon, ReplyIcon } from './icons';
import { afterMenu } from './ThreadToolbar';
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

export function MobileActionBar({ detail, canArchive, canTrash, onAction, onMoveTo }: MobileActionBarProps) {
  const { mailboxes } = useMail();
  const current = mailboxes?.find((m) => m.id === detail.mailboxId) ?? null;
  const inbox = mailboxes?.find((m) => m.specialUse === 'inbox' || m.name.toUpperCase() === 'INBOX') ?? null;
  const model = toolbarModel(current?.specialUse);
  const starred = isStarred(detail);
  const canReply = model.lead === 'reply' || model.icons.includes('reply');
  const moreRef = useRef<HTMLButtonElement>(null);
  const rescue = (model.lead === 'notJunk' || model.lead === 'rescue') && onMoveTo !== undefined && inbox !== null ? model.lead : null;

  return (
    <ActionBar aria-label="Message actions" forceVisible className="pr-abar" data-testid="action-bar">
      {model.labelled.includes('archive') ? (
        <ActionBarItem label={ACTION_LABEL.archive} icon={<ArchiveIcon />} disabled={!canArchive} onClick={() => { onAction('archive'); }} />
      ) : null}
      <ActionBarItem label={ACTION_LABEL.delete} icon={<TrashIcon />} disabled={!canTrash} onClick={() => { onAction('delete'); }} />
      <ActionBarItem label="Move" icon={<FolderIcon />} onClick={() => { onAction('moveTo'); }} />
      {rescue !== null && inbox !== null && onMoveTo !== undefined ? (
        <ActionBarItem label={ACTION_LABEL[rescue]} icon={<ArchiveIcon />} tone="accent" onClick={() => { onMoveTo(detail, inbox); }} />
      ) : canReply ? (
        <ActionBarItem label={ACTION_LABEL.reply} icon={<ReplyIcon />} tone="accent" onClick={() => { onAction('reply'); }} />
      ) : null}
      <Menu>
        <MenuTrigger>
          {/* The word under the icon is "More"; the name says what it holds (it contains the word). */}
          <ActionBarItem ref={moreRef} label="More" aria-label="More actions" icon={<MoreIcon />} />
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
          <MenuItem onSelect={() => { afterMenu(() => { requestInspect(moreRef.current); }); }}>Inspect message</MenuItem>
          {/* PST-T-20.1: the phone hides the toolbar, so the app link lives in the bar's menu. */}
          {onApple() ? <MenuItem onSelect={() => { openInConstellation(detail.id); }}>{CONSTELLATION_LABEL}</MenuItem> : null}
        </MenuContent>
      </Menu>
    </ActionBar>
  );
}
