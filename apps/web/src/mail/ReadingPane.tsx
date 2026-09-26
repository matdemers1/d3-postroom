// One message: its headers, its text body, its attachments, and what you can do with it. The main
// view stays calm — who, when, what it says — and the evidence (authentication, routing, raw
// headers) waits for the Inspect drawer (PST-P-6).
//
// HTML is never put into this document (PST-REQ-159/175). The sanitised renderer on the usercontent
// origin is PST-T-3.12; until it lands the text/plain part is shown, and an HTML-only message says so.
import { forwardRef, type ReactNode } from 'react';
import { Alert, Button, Cluster, DescriptionItem, DescriptionList, EmptyState, Skeleton, Stack } from '@d3cloud/ui';
import { attachmentUrl, type MessageBody, type MessageDetail } from '../api';
import { byteSize, fullDate, header } from './format';
import { PaperclipIcon, StarIcon } from './icons';
import { isStarred } from './list';

export interface OpenMessage {
  id: string;
  status: 'loading' | 'ready' | 'missing' | 'error';
  detail: MessageDetail | null;
  body: MessageBody | null;
  bodyStatus: 'loading' | 'ready' | 'error';
}

export interface ReadingPaneProps {
  open: OpenMessage | null;
  back?: ReactNode;
  canArchive: boolean;
  canTrash: boolean;
  onAction: (action: 'reply' | 'replyAll' | 'forward' | 'archive' | 'delete' | 'markUnread' | 'star') => void;
  onRetry: () => void;
  children?: ReactNode;
}

export const ReadingPane = forwardRef<HTMLHeadingElement, ReadingPaneProps>(function ReadingPane(
  { open, back, canArchive, canTrash, onAction, onRetry, children },
  headingRef,
) {
  if (open === null) {
    return (
      <section className="pr-reader pr-reader--empty" aria-label="Reading pane">
        <EmptyState kind="empty" heading="No message open" size="inline" headingLevel={2}>
          Choose a message from the list. Press ? for keyboard shortcuts.
        </EmptyState>
      </section>
    );
  }
  if (open.status === 'loading') {
    return (
      <section className="pr-reader" aria-label="Reading pane" aria-busy="true">
        {back}
        <Stack gap="16">
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="text" lines={3} />
          <Skeleton variant="block" height={160} />
        </Stack>
      </section>
    );
  }
  if (open.status === 'missing') {
    return (
      <section className="pr-reader" aria-label="Reading pane">
        {back}
        <EmptyState kind="no-results" heading="This message is not here anymore" size="inline" headingLevel={2}>
          It was moved or deleted, perhaps from another device.
        </EmptyState>
      </section>
    );
  }
  if (open.status === 'error' || open.detail === null) {
    return (
      <section className="pr-reader" aria-label="Reading pane">
        {back}
        <EmptyState kind="error" heading="Could not open this message" size="inline" headingLevel={2} action={<Button onClick={onRetry}>Try again</Button>}>
          Postroom did not answer. Check your connection.
        </EmptyState>
      </section>
    );
  }

  const { detail, body } = open;
  const subject = detail.subject === null || detail.subject === '' ? '(no subject)' : detail.subject;
  const from = header(body, 'From') ?? detail.from ?? '';
  const to = header(body, 'To');
  const cc = header(body, 'Cc');
  const starred = isStarred(detail);
  const attachments = body?.attachments.filter((a) => a.disposition === 'attachment' || a.filename !== null) ?? [];

  return (
    <article className="pr-reader" aria-labelledby="pr-reader-subject" data-message-id={detail.id}>
      {back}
      <Stack gap="16">
        <h2 id="pr-reader-subject" className="pr-reader__subject" tabIndex={-1} ref={headingRef}>
          {subject}
        </h2>
        <div role="group" aria-label="Message actions">
          <Cluster gap="8">
            <Button size="sm" variant="secondary" onClick={() => { onAction('reply'); }}>Reply</Button>
            <Button size="sm" variant="ghost" onClick={() => { onAction('replyAll'); }}>Reply all</Button>
            <Button size="sm" variant="ghost" onClick={() => { onAction('forward'); }}>Forward</Button>
            <Button size="sm" variant="ghost" disabled={!canArchive} onClick={() => { onAction('archive'); }}>Archive</Button>
            <Button size="sm" variant="ghost" disabled={!canTrash} onClick={() => { onAction('delete'); }}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => { onAction('markUnread'); }}>Mark unread</Button>
            <Button size="sm" variant="ghost" pressed={starred} icon={<StarIcon filled={starred} />} onClick={() => { onAction('star'); }}>
              Star
            </Button>
          </Cluster>
        </div>
        <DescriptionList className="pr-reader__meta">
          <DescriptionItem term="From">{from === '' ? '(unknown sender)' : from}</DescriptionItem>
          {to !== null ? <DescriptionItem term="To">{to}</DescriptionItem> : null}
          {cc !== null ? <DescriptionItem term="Cc">{cc}</DescriptionItem> : null}
          <DescriptionItem term="Date" numeric>
            <time dateTime={detail.date}>{fullDate(detail.date)}</time>
          </DescriptionItem>
        </DescriptionList>
        {children}
        <MessageText body={body} status={open.bodyStatus} onRetry={onRetry} />
        {attachments.length > 0 ? (
          <section aria-label="Attachments" className="pr-reader__attachments">
            <h3 className="pr-reader__h3">
              {attachments.length === 1 ? '1 attachment' : `${String(attachments.length)} attachments`}
            </h3>
            <ul className="pr-attachments">
              {attachments.map((a) => (
                <li key={a.partId}>
                  <a className="pr-attachment" href={attachmentUrl(detail.id, a.partId)} download={a.filename ?? `part-${a.partId}`}>
                    <PaperclipIcon />
                    <span className="pr-attachment__name">{a.filename ?? `Part ${a.partId}`}</span>
                    <span className="pr-attachment__size">{byteSize(a.size)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Stack>
    </article>
  );
});

function MessageText({ body, status, onRetry }: { body: MessageBody | null; status: OpenMessage['bodyStatus']; onRetry: () => void }) {
  if (status === 'loading') return <Skeleton variant="text" lines={6} />;
  if (status === 'error' || body === null) {
    return (
      <Alert tone="warning" title="The message body could not be loaded" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        The headers above are right; the text did not arrive.
      </Alert>
    );
  }
  const htmlNote =
    body.html === null ? null : (
      <p className="pr-reader__note" data-testid="html-placeholder">
        {body.text === null
          ? 'This message has an HTML version only. The viewer for it arrives soon.'
          : 'This message also has an HTML version. The viewer for it arrives soon; this is its plain-text part.'}
      </p>
    );
  return (
    <>
      {htmlNote}
      {body.text !== null ? (
        <div className="pr-reader__body" data-testid="message-text">
          {body.text}
        </div>
      ) : body.html === null ? (
        <p className="pr-reader__note">This message has no text.</p>
      ) : null}
      {body.textTruncated ? <p className="pr-reader__note">This text was cut short. The full message is in its raw form.</p> : null}
    </>
  );
}
