// The pieces of the open message the redesign canvas added (PST-T-15.3, PST-REQ-194), kept out of
// ReadingPane.tsx so they render to a string in unit tests: the subject block, the quick-reply bar at
// the foot of the thread, and the open message header's Star and Reply.
import type { ForwardedRef } from 'react';
import { Button, IconButton, Tooltip } from '@d3cloud/ui';
import type { MessageBody, MessageDetail } from '../../api';
import { header } from '../format';
import { isStarred } from '../list';
import { useMail } from '../MailContext';
import { ReplyIcon, StarIcon } from './icons';
import type { ToolbarAction } from './ThreadToolbar';
import { ACTION_KEY, ACTION_LABEL, quickReplyLabel, readingToolbar, tooltipText } from './view';

/**
 * The subject block (the canvas's `.pr-subject`): the heading focus lands on when a message opens,
 * then one quiet line: for a conversation, how many messages and who wrote them. The Priority label
 * is the header's bucket chip (with its "why"), so it is not repeated here.
 */
export function SubjectBlock({ subject, headingRef, participants }: { subject: string; headingRef: ForwardedRef<HTMLHeadingElement>; participants: string | null }) {
  return (
    <header className="pr-subject">
      <h2 id="pr-reader-subject" className="pr-reader__subject" tabIndex={-1} ref={headingRef}>
        {subject}
      </h2>
      {participants !== null ? (
        <p className="pr-subject__meta">
          <span data-testid="thread-participants">{participants}</span>
        </p>
      ) : null}
    </header>
  );
}

/**
 * The quick-reply bar at the foot of the thread (the canvas's `.pr-quickreply`): a quiet, field-like
 * button — "Reply to Priya Shah…" with its R hint — that opens the same inline composer r does, then
 * Reply all and Forward. Only where a reply makes sense (not in Drafts); the composer replaces it.
 */
export function QuickReply({ detail, body, onAction }: { detail: MessageDetail; body: MessageBody | null; onAction: (action: ToolbarAction) => void }) {
  const { mailboxes, me } = useMail();
  const use = mailboxes?.find((m) => m.id === detail.mailboxId)?.specialUse;
  if (!readingToolbar(use).reply) return null;
  const from = header(body, 'From') ?? detail.from;
  return (
    <div className="pr-quickreply" data-testid="quick-reply">
      <button type="button" className="pr-quickreply__field" aria-keyshortcuts={ACTION_KEY.reply} onClick={() => { onAction('reply'); }}>
        <span className="pr-quickreply__icon" aria-hidden="true">
          <ReplyIcon />
        </span>
        <span className="pr-quickreply__label">{quickReplyLabel(from, me)}</span>
        <kbd className="d3-kbd pr-quickreply__key" aria-hidden="true">
          R
        </kbd>
      </button>
      <Button size="sm" variant="secondary" aria-keyshortcuts={ACTION_KEY.replyAll} onClick={() => { onAction('replyAll'); }}>
        {ACTION_LABEL.replyAll}
      </Button>
      <Button size="sm" variant="ghost" aria-keyshortcuts={ACTION_KEY.forward} onClick={() => { onAction('forward'); }}>
        {ACTION_LABEL.forward}
      </Button>
    </div>
  );
}

/** Star and Reply on the open message's header (the canvas's `.pr-msghead` icon buttons). */
export function HeaderActions({ detail, onAction }: { detail: MessageDetail; onAction: (action: ToolbarAction) => void }) {
  const { mailboxes } = useMail();
  const use = mailboxes?.find((m) => m.id === detail.mailboxId)?.specialUse;
  const starred = isStarred(detail);
  return (
    <>
      <Tooltip content={tooltipText(starred ? 'Unstar' : 'Star', ACTION_KEY.star)}>
        <IconButton size="sm" variant="ghost" label="Star" pressed={starred} aria-keyshortcuts={ACTION_KEY.star} icon={<StarIcon filled={starred} />} onClick={() => { onAction('star'); }} />
      </Tooltip>
      {readingToolbar(use).reply ? (
        <Tooltip content={tooltipText(ACTION_LABEL.reply, ACTION_KEY.reply)}>
          <IconButton size="sm" variant="ghost" label={ACTION_LABEL.reply} aria-keyshortcuts={ACTION_KEY.reply} icon={<ReplyIcon />} onClick={() => { onAction('reply'); }} />
        </Tooltip>
      ) : null}
    </>
  );
}
