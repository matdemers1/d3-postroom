// One message, or the whole thread it belongs to (PST-T-3.15, PST-REQ-079): its headers, its text
// body, its attachments, its delivery timeline when it went out, and what you can do with it. The
// main view stays calm — who, when, what it says — and the evidence (authentication, routing, raw
// headers) waits for the Inspect drawer (PST-P-6).
//
// A message with replies shows the whole conversation (GET /api/threads/:id): older messages
// collapsed to a sender/date row, the newest expanded, and whichever message was opened expanded
// too. It follows the server live over SSE (PST-REQ-083) — a reply filed anywhere joins the open
// thread without a reload. Pure ordering/collapse logic lives in ./thread.ts, unit tested there.
//
// A sent message's per-recipient delivery state and attempt log (PST-T-6.4, PST-REQ-119) sits below
// its body: a state badge, a deferral's reason and next retry, and every attempt's transport, MX and
// remote response. Pure formatting lives in ./delivery.ts, unit tested there.
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
import { forwardRef, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Badge, Button, Cluster, DescriptionItem, DescriptionList, EmptyState, Skeleton, Stack } from '@d3cloud/ui';
import { attemptRemoteText, attemptSummary, deferralReason, deliveryPhase, dsnFiledAt, isPending, NO_DELIVERY_RECORD_TEXT, relativeMinutes, STATE_LABEL, STATE_TONE } from './delivery';
import { InspectDrawer } from './InspectDrawer';
import { InviteSection } from '../invites/InviteSection';
import { ReceiptPrompt } from './ReceiptPrompt';
import { wantsReceipt } from './receipt';
import { useMail } from './MailContext';
import { collapsedSummary, isConversation, mightJoinThread, threadRows, toggleRow } from './thread';
import { trackersBlockedNote } from './trackers';
import {
  api,
  ApiError,
  attachmentUrl,
  contactPath,
  contactsApi,
  type DeliveryDetail,
  type DeliveryRecipient,
  type MessageBody,
  type MessageDetail,
  type MessageSummary,
  type Phish,
  type RenderTicket,
} from '../api';
import { byteSize, fullDate, header } from './format';
import { PaperclipIcon, StarIcon } from './icons';
import { isStarred } from './list';
import { PHISH_TONE_OF, phishWarningTitle, sortPhishWarnings } from './phish';
import { SessionEnded } from '../screens/states';

export interface OpenMessage {
  id: string;
  status: 'loading' | 'ready' | 'missing' | 'error' | 'signed-out';
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
  if (open.status === 'signed-out') {
    return (
      <section className="pr-reader" aria-label="Reading pane">
        {back}
        <SessionEnded size="inline" />
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

  const { detail, body, bodyStatus } = open;
  const subject = detail.subject === null || detail.subject === '' ? '(no subject)' : detail.subject;
  const starred = isStarred(detail);

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
            <InspectDrawer messageId={detail.id} />
          </Cluster>
        </div>
        {children}
        <ThreadConversation
          detail={detail}
          body={body}
          bodyStatus={bodyStatus}
          onRetry={onRetry}
          fallback={<MessageContent detail={detail} body={body} bodyStatus={bodyStatus} onRetry={onRetry} />}
        />
      </Stack>
    </article>
  );
});

// --- The thread (PST-T-3.15, PST-REQ-079) ------------------------------------------------------

interface ExtraMessage {
  status: 'loading' | 'ready' | 'error';
  detail: MessageDetail | null;
  body: MessageBody | null;
  bodyStatus: 'loading' | 'ready' | 'error';
}

const LOADING_EXTRA: ExtraMessage = { status: 'loading', detail: null, body: null, bodyStatus: 'loading' };

/**
 * Renders `fallback` (the ordinary single-message view) unless the open message's thread has more
 * than one message, in which case it renders the conversation instead: older messages collapsed,
 * the newest expanded, the message that was opened expanded too — kept live over SSE. All of this
 * component's hooks run unconditionally so the branch can be decided at the very end.
 */
function ThreadConversation({
  detail,
  body,
  bodyStatus,
  onRetry,
  fallback,
}: {
  detail: MessageDetail;
  body: MessageBody | null;
  bodyStatus: OpenMessage['bodyStatus'];
  onRetry: () => void;
  fallback: ReactNode;
}): ReactNode {
  const { subscribe } = useMail();
  // `detail.threadId` is whatever MailView last fetched, which can be stale: a message's very first
  // reply backfills ITS threadId server-side (packages/threading's orphan step) at the moment the
  // reply is sent, but nothing forces MailView to refetch the still-open original afterwards. This
  // component's own mount is the moment to ask again, so a remount (Composer closing back to it,
  // exactly when a reply was just sent) always gets the current answer rather than the stale null.
  const [threadId, setThreadId] = useState<string | null>(detail.threadId);
  const [thread, setThread] = useState<MessageSummary[] | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [extra, setExtra] = useState<ReadonlyMap<string, ExtraMessage>>(new Map());

  const loadThread = useCallback((id: string | null) => {
    if (id === null) return;
    api.thread(id).then(
      (t) => { setThread(t.messages); },
      () => undefined,
    );
  }, []);

  // A different open message starts fresh, and re-asks the server for its current threadId.
  useEffect(() => {
    let cancelled = false;
    setThread(null);
    setToggled(new Set());
    setExtra(new Map());
    setThreadId(detail.threadId);
    if (detail.threadId !== null) loadThread(detail.threadId);
    api.message(detail.id).then(
      (d) => {
        if (cancelled) return;
        setThreadId(d.threadId);
        if (d.threadId !== null && d.threadId !== detail.threadId) loadThread(d.threadId);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [detail.id, detail.threadId, loadThread]);

  // Live: any newly filed message could be a reply that just joined this thread.
  useEffect(() => {
    if (!mightJoinThread(threadId)) return;
    return subscribe((event) => {
      if (event.type === 'message.new' || event.type === 'reconnected') loadThread(threadId);
    });
  }, [threadId, subscribe, loadThread]);

  const rows = thread === null ? [] : threadRows(thread, detail.id, toggled);
  const expandedIds = rows.filter((r) => r.expanded).map((r) => r.message.id);
  const expandedKey = expandedIds.join(',');

  // Fetch full detail/body for any expanded row other than the one already loaded by the caller.
  useEffect(() => {
    const need = expandedIds.filter((id) => id !== detail.id);
    if (need.length === 0) return;
    setExtra((prev) => {
      const missing = need.filter((id) => !prev.has(id));
      if (missing.length === 0) return prev;
      const next = new Map(prev);
      for (const id of missing) next.set(id, LOADING_EXTRA);
      return next;
    });
    let cancelled = false;
    const patch = (id: string, patch_: Partial<ExtraMessage>) => {
      if (cancelled) return;
      setExtra((prev) => {
        const next = new Map(prev);
        next.set(id, { ...(prev.get(id) ?? LOADING_EXTRA), ...patch_ });
        return next;
      });
    };
    for (const id of need) {
      api.message(id).then(
        (d) => { patch(id, { status: 'ready', detail: d }); },
        () => { patch(id, { status: 'error' }); },
      );
      api.messageBody(id).then(
        (b) => { patch(id, { body: b, bodyStatus: 'ready' }); },
        () => { patch(id, { bodyStatus: 'error' }); },
      );
    }
    return () => {
      cancelled = true;
    };
    // expandedKey (a joined string) is the real dependency; expandedIds is derived from thread/toggled
    // state each render and would make this effect fire on every render if listed directly.
  }, [expandedKey, detail.id]);

  if (thread === null || !isConversation(thread)) return fallback;

  const threadSubject = thread[thread.length - 1]?.subject ?? null;

  return (
    <Stack as="ol" gap="12" aria-label="Conversation" className="pr-thread">
      {rows.map(({ message, expanded }) => {
        const isOpen = message.id === detail.id;
        const rowDetail = isOpen ? detail : (extra.get(message.id)?.detail ?? null);
        const rowBody = isOpen ? body : (extra.get(message.id)?.body ?? null);
        const rowBodyStatus = isOpen ? bodyStatus : (extra.get(message.id)?.bodyStatus ?? 'loading');
        return (
          <li key={message.id} className="pr-thread__item" data-message-id={message.id} data-expanded={expanded}>
            {expanded ? (
              rowDetail === null ? (
                <Skeleton variant="text" lines={3} />
              ) : (
                <MessageContent detail={rowDetail} body={rowBody} bodyStatus={rowBodyStatus} onRetry={onRetry} />
              )
            ) : (
              <button
                type="button"
                className="pr-thread__collapsed"
                aria-expanded={false}
                onClick={() => { setToggled((t) => toggleRow(t, message.id)); }}
              >
                <span className="pr-thread__collapsed-summary">{collapsedSummary(message, threadSubject)}</span>
                <span className="pr-reader__note">{fullDate(message.date)}</span>
              </button>
            )}
          </li>
        );
      })}
    </Stack>
  );
}

// --- One message's content: meta, phishing banner, body, attachments, delivery -----------------

function MessageMeta({ detail, body }: { detail: MessageDetail; body: MessageBody | null }) {
  const from = header(body, 'From') ?? detail.from ?? '';
  const to = header(body, 'To');
  const cc = header(body, 'Cc');
  // PST-REQ-137: a sender who is in the address book links to their card.
  const [contact, setContact] = useState<{ addressBookId: string; name: string; displayName: string } | null>(null);
  useEffect(() => {
    setContact(null);
    const address = detail.from;
    if (address === null || address === '') return undefined;
    let live = true;
    contactsApi
      .lookup(address)
      .then((r) => {
        if (live) setContact(r.contact);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [detail.from]);
  return (
    <DescriptionList className="pr-reader__meta">
      <DescriptionItem term="From">
        {from === '' ? '(unknown sender)' : from}
        {contact === null ? null : (
          <>
            {' · '}
            <RouterLink to={contactPath(contact.addressBookId, contact.name)}>In contacts as {contact.displayName}</RouterLink>
          </>
        )}
      </DescriptionItem>
      {to !== null ? <DescriptionItem term="To">{to}</DescriptionItem> : null}
      {cc !== null ? <DescriptionItem term="Cc">{cc}</DescriptionItem> : null}
      <DescriptionItem term="Date" numeric>
        <time dateTime={detail.date}>{fullDate(detail.date)}</time>
      </DescriptionItem>
    </DescriptionList>
  );
}

function Attachments({ messageId, body }: { messageId: string; body: MessageBody | null }) {
  const attachments = body?.attachments.filter((a) => a.disposition === 'attachment' || a.filename !== null) ?? [];
  if (attachments.length === 0) return null;
  return (
    <section aria-label="Attachments" className="pr-reader__attachments">
      <h3 className="pr-reader__h3">{attachments.length === 1 ? '1 attachment' : `${String(attachments.length)} attachments`}</h3>
      <ul className="pr-attachments">
        {attachments.map((a) => (
          <li key={a.partId}>
            <a className="pr-attachment" href={attachmentUrl(messageId, a.partId)} download={a.filename ?? `part-${a.partId}`}>
              <PaperclipIcon />
              <span className="pr-attachment__name">{a.filename ?? `Part ${a.partId}`}</span>
              <span className="pr-attachment__size">{byteSize(a.size)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MessageContent({
  detail,
  body,
  bodyStatus,
  onRetry,
}: {
  detail: MessageDetail;
  body: MessageBody | null;
  bodyStatus: OpenMessage['bodyStatus'];
  onRetry: () => void;
}) {
  const { mailboxes } = useMail();
  const use = mailboxes?.find((m) => m.id === detail.mailboxId)?.specialUse;
  const ownMailbox = use === 'sent' || use === 'drafts';
  return (
    <Stack gap="16">
      <MessageMeta detail={detail} body={body} />
      <PhishBanner phish={detail.phish} />
      {wantsReceipt(detail, body, ownMailbox) ? <ReceiptPrompt key={detail.id} messageId={detail.id} /> : null}
      <InviteSection messageId={detail.id} />
      <MessageText body={body} status={bodyStatus} onRetry={onRetry} />
      <Attachments messageId={detail.id} body={body} />
      <DeliverySection messageId={detail.id} mailboxId={detail.mailboxId} />
    </Stack>
  );
}

// --- Delivery timeline (PST-T-6.4, PST-T-6.7, PST-REQ-119) --------------------------------------

interface DeliverySectionState {
  status: 'loading' | 'ready' | 'no-record' | 'error';
  data: DeliveryDetail | null;
}

const LOADING_DELIVERY: DeliverySectionState = { status: 'loading', data: null };

/** A sent message's per-recipient state and attempt log, found with one indexed server-side lookup
 *  (GET /api/messages/:id/outbound, PST-T-6.7) instead of scanning the account's recent sends. When
 *  the lookup finds no linked OutboundMessage row — never sent through Postroom at all, or a Sent
 *  copy another client APPENDed directly — an explicit note is shown rather than nothing, since that
 *  silence used to look identical to "still loading". */
function DeliverySection({ messageId, mailboxId }: { messageId: string; mailboxId: string }) {
  const { subscribe, mailboxes } = useMail();
  // Received mail has no delivery of ours to show; only a copy in Sent says so out loud.
  const inSent = mailboxes?.find((m) => m.id === mailboxId)?.specialUse === 'sent';
  const [state, setState] = useState<DeliverySectionState>(LOADING_DELIVERY);

  const load = useCallback(() => {
    api.messageOutbound(messageId).then(
      ({ outboundId }) => {
        if (outboundId === null || deliveryPhase(outboundId) === 'no-record') {
          setState({ status: 'no-record', data: null });
          return;
        }
        api.messageDelivery(outboundId).then(
          (data) => { setState({ status: 'ready', data }); },
          (error: unknown) => {
            setState({ status: error instanceof ApiError && error.status === 404 ? 'no-record' : 'error', data: null });
          },
        );
      },
      () => { setState({ status: 'error', data: null }); },
    );
  }, [messageId]);

  useEffect(() => {
    setState(LOADING_DELIVERY);
    load();
  }, [load]);

  const pending = state.data?.recipients.some((r) => isPending(r.state)) ?? false;

  // While anything can still change on its own: every 30 s, and sooner on any mail event.
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(load, 30_000);
    return () => { clearInterval(timer); };
  }, [pending, load]);

  useEffect(() => {
    if (!pending) return undefined;
    return subscribe(() => { load(); });
  }, [pending, subscribe, load]);

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <Alert tone="warning" title="The delivery timeline could not be loaded" actions={<Button size="sm" onClick={load}>Try again</Button>}>
        Postroom did not answer. Check your connection.
      </Alert>
    );
  }
  if (state.status === 'no-record' || state.data === null) {
    if (!inSent) return null;
    return (
      <section aria-label="Delivery" className="pr-delivery" data-testid="delivery">
        <h3 className="pr-reader__h3">Delivery</h3>
        <p className="pr-delivery__attempts" data-testid="delivery-no-record">
          {NO_DELIVERY_RECORD_TEXT}
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Delivery" className="pr-delivery" data-testid="delivery">
      <h3 className="pr-reader__h3">Delivery</h3>
      <ul className="pr-delivery__list">
        {state.data.recipients.map((r) => (
          <DeliveryRecipientRow key={r.id} recipient={r} />
        ))}
      </ul>
    </section>
  );
}

function DeliveryRecipientRow({ recipient: r }: { recipient: DeliveryRecipient }) {
  const reason = deferralReason(r);
  const dsnAt = dsnFiledAt(r);
  return (
    <li className="pr-delivery__recipient" data-testid="delivery-recipient" data-state={r.state}>
      <div className="pr-delivery__head">
        <Badge tone={STATE_TONE[r.state]} data-testid="delivery-state">
          {STATE_LABEL[r.state]}
        </Badge>
        <span className="pr-delivery__address">{r.address}</span>
      </div>
      {reason !== null ? (
        <p className="pr-reader__note" data-testid="deferral-reason">
          {reason}
        </p>
      ) : null}
      {r.state === 'deferred' ? (
        <p className="pr-reader__note" data-testid="next-retry">
          Next retry at {fullDate(r.nextAttemptAt)} ({relativeMinutes(r.nextAttemptAt)}).
        </p>
      ) : null}
      {r.state === 'bounced' && dsnAt !== null ? (
        <p className="pr-reader__note" data-testid="dsn-note">
          A delivery failure notice was filed to your Inbox at {fullDate(dsnAt)}.
        </p>
      ) : null}
      {r.attemptsLog.length > 0 ? (
        <ol className="pr-delivery__attempts" aria-label={`Attempts for ${r.address}`}>
          {r.attemptsLog.map((a) => {
            const remote = attemptRemoteText(a);
            return (
              <li key={a.startedAt}>
                <span>
                  {fullDate(a.startedAt)} · {attemptSummary(a)}
                </span>
                {remote !== null ? <span className="pr-reader__note"> — {remote}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </li>
  );
}

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
