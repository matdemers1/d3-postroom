// One message: its headers, its text body, its attachments, and what you can do with it. The main
// view stays calm — who, when, what it says — and the evidence (authentication, routing, raw
// headers) waits for the Inspect drawer (PST-P-6).
//
// HTML is never put into this document (PST-REQ-159/175). It is sanitised on the server and shown
// from the separate usercontent origin in a sandboxed frame (PST-T-3.12, PST-REQ-081): no
// allow-scripts, no allow-same-origin, no referrer. Remote images stay blocked until the reader
// presses "Load images", which asks for a new render that routes them through the image proxy
// (PST-REQ-082) — the browser itself never contacts a sender's host.
//
// Height: nothing runs inside the frame, so it cannot report its content height (no postMessage).
// The frame has a fixed height (MAIL_FRAME_HEIGHT) and scrolls inside itself — chosen over a
// server-computed guess, which would be wrong for any message whose layout depends on width.
//
// When the server has no usercontent origin configured (503), the text/plain part is shown instead
// and an HTML-only message says so.
import { forwardRef, useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Cluster, DescriptionItem, DescriptionList, EmptyState, Skeleton, Stack } from '@d3cloud/ui';
import { trackersBlockedNote } from './trackers';
import { api, ApiError, attachmentUrl, type MessageBody, type MessageDetail, type Phish, type RenderTicket } from '../api';
import { byteSize, fullDate, header } from './format';
import { PaperclipIcon, StarIcon } from './icons';
import { isStarred } from './list';
import { PHISH_TONE_OF, phishWarningTitle, sortPhishWarnings } from './phish';

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
        <PhishBanner phish={detail.phish} />
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

// --- Phishing/lookalike warnings (PST-T-6.5, PST-REQ-120) ---------------------------------------
//
// One warning per detection, worst first, each with its full reason (never just the kind label —
// the label is a heading, the reason is the sentence that says why). A `high`-severity warning is
// what actually happened to *this* message just now, so it interrupts like any other dynamic error
// (role="alert"); `medium`/`low` sit quietly in the same named region, discoverable by landmark
// navigation without a screen reader announcing over whatever the reader was doing. Sorting and
// labelling live in ./phish.ts, unit tested there.

function PhishBanner({ phish }: { phish: Phish | null }) {
  if (phish === null || phish.warnings.length === 0) return null;
  const sorted = sortPhishWarnings(phish.warnings);
  return (
    <section aria-label="Phishing and authentication warnings" className="pr-reader__phish" data-testid="phish-warnings">
      <Stack gap="8">
        {sorted.map((w, index) => (
          <Alert
            key={`${w.kind}-${String(index)}`}
            tone={PHISH_TONE_OF[w.severity]}
            title={phishWarningTitle(w.kind)}
            dynamic={w.severity === 'high'}
            data-testid="phish-warning"
            data-phish-kind={w.kind}
            data-phish-severity={w.severity}
          >
            {w.reason}
          </Alert>
        ))}
      </Stack>
    </section>
  );
}

/** The frame's sandbox: popups only, so a link (target=_blank, noopener) opens in a normal tab. No scripts, no same-origin. */
export const MAIL_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
/** Fixed, because no script in the frame can report its content height; the frame scrolls inside. */
export const MAIL_FRAME_HEIGHT = '70vh';

/** What the reader is told about blocked remote images; null when there is nothing to say. */
export function blockedImagesNote(ticket: Pick<RenderTicket, 'images' | 'remoteImages'>): string | null {
  if (ticket.images || ticket.remoteImages === 0) return null;
  if (ticket.remoteImages === 1) return "One image comes from the sender's servers. Loading it would tell them you opened this message, so it is blocked.";
  return `${String(ticket.remoteImages)} images come from the sender's servers. Loading them would tell them you opened this message, so they are blocked.`;
}

type FrameState = { status: 'loading' } | { status: 'ready'; ticket: RenderTicket } | { status: 'unavailable' } | { status: 'error' };

function HtmlFrame({ messageId, fallback, note: lead }: { messageId: string; fallback: ReactNode; note: ReactNode }) {
  const [images, setImages] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<FrameState>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    api.renderMessage(messageId, images).then(
      (ticket) => {
        if (live) setState({ status: 'ready', ticket });
      },
      (error: unknown) => {
        if (live) setState(error instanceof ApiError && error.status === 503 ? { status: 'unavailable' } : { status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [messageId, images, attempt]);

  if (state.status === 'loading') return <Skeleton variant="block" height={160} />;
  if (state.status === 'unavailable') return <>{fallback}</>;
  if (state.status === 'error') {
    return (
      <Alert tone="warning" title="The formatted message could not be shown" actions={<Button size="sm" onClick={() => { setAttempt((n) => n + 1); }}>Try again</Button>}>
        Postroom did not answer. Check your connection.
      </Alert>
    );
  }
  const note = blockedImagesNote(state.ticket);
  const trackers = trackersBlockedNote(state.ticket);
  return (
    <Stack gap="8">
      {lead}
      {trackers !== null ? (
        <Alert tone="info" title="Tracking removed" data-testid="trackers-blocked">
          {trackers}. Postroom stripped these before showing the message, so the sender cannot see that you opened it.
        </Alert>
      ) : null}
      {note !== null ? (
        <Alert
          tone="info"
          title="Remote images blocked"
          data-testid="remote-images-blocked"
          actions={<Button size="sm" onClick={() => { setImages(true); }}>Load images</Button>}
        >
          {note}
        </Alert>
      ) : null}
      <iframe
        key={state.ticket.url}
        title="Message content"
        data-testid="message-html"
        src={state.ticket.url}
        sandbox={MAIL_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        style={{
          display: 'block',
          width: '100%',
          height: MAIL_FRAME_HEIGHT,
          boxSizing: 'border-box',
          border: 'var(--border-width) solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
        }}
      />
    </Stack>
  );
}

function MessageText({ body, status, onRetry }: { body: MessageBody | null; status: OpenMessage['bodyStatus']; onRetry: () => void }) {
  if (status === 'loading') return <Skeleton variant="text" lines={6} />;
  if (status === 'error' || body === null) {
    return (
      <Alert tone="warning" title="The message body could not be loaded" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        The headers above are right; the text did not arrive.
      </Alert>
    );
  }
  const text = (
    <>
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
  if (body.html === null) return text;
  // The server cannot render HTML (no usercontent origin): the plain-text part, and a word about it.
  const fallback = (
    <>
      <p className="pr-reader__note" data-testid="html-placeholder">
        {body.text === null
          ? 'This message has an HTML version only, and this server is not set up to show HTML.'
          : 'This message also has an HTML version; this server is not set up to show HTML, so this is its plain-text part.'}
      </p>
      {text}
    </>
  );
  const lead =
    body.text === null ? (
      <p className="pr-reader__note" data-testid="html-placeholder">
        This message has an HTML version only. It is shown in a sealed frame: nothing in it can run, and nothing loads from the sender.
      </p>
    ) : null;
  return (
    <>
      <HtmlFrame key={body.id} messageId={body.id} fallback={fallback} note={lead} />
      {body.htmlTruncated ? <p className="pr-reader__note">This message was cut short. The full message is in its raw form.</p> : null}
    </>
  );
}
