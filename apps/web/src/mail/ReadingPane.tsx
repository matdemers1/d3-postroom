// One message, or the whole thread it belongs to (PST-T-3.15, PST-REQ-079): its headers, its text
// body, its attachments, its delivery state when it went out, and what you can do with it. The
// main view stays calm — who, when, what it says — and the evidence (authentication, routing, raw
// headers, the attempt log) waits for the Inspect drawer (PST-P-6).
//
// PST-T-14.6 (PST-ADR-011, calm webmail; design audit VIS-06, VIS-07, CPY-01, CPY-02, MOD-I4,
// INT-I7, INT-I8) reshaped the pane:
//   - the toolbar (./thread/ThreadToolbar.tsx) has one lead, two labelled triage buttons, icon
//     buttons with tooltips, and a ⋯ menu — Inspect's trigger moved there and into chips' Details;
//   - each message header is one line (./thread/MessageHeader.tsx); the address block opens in place;
//   - earlier messages are one-line cards that open with height + opacity over --dur-2
//     (PST-REQ-192; none under reduced motion, PST-REQ-193);
//   - chips appear only for exceptions (./thread/ExceptionChip.tsx) — never a "Verified" one.
//
// PST-T-15.3 (PST-REQ-194) drew it to the redesign canvas: the 52px toolbar row on top (ghost icon
// buttons, "3 of 48" with up/down, ⋯); then, in the one scroller, the subject block (24px title, a
// Priority badge when the message is filed there, "3 messages · Priya Shah, Jonah Reyes, you"),
// earlier messages as one-line hairline cards, the expanded messages (36px tinted avatar, "to me, …",
// time, Star and Reply on the open one; the body at 16px with a 65ch measure, indented under the
// name), attachments as cards (./AttachmentCard.tsx), and a quick-reply bar at the foot — a quiet
// field-like "Reply to Priya Shah…" button with its R hint that opens the same inline composer r
// does, and Reply all / Forward beside it. The bar steps aside while a composer is open.
//
// A message with replies shows the whole conversation (GET /api/threads/:id): older messages
// collapsed, the newest expanded, and whichever message was opened expanded too. It follows the
// server live over SSE (PST-REQ-083) — a reply filed anywhere joins the open thread without a
// reload. Pure ordering/collapse logic lives in ./thread.ts, unit tested there.
//
// HTML is never put into this document (PST-REQ-159/175). It is sanitised on the server and shown
// from the separate usercontent origin in a sandboxed frame (PST-T-3.12, PST-REQ-081): no
// allow-scripts, no allow-same-origin, no referrer. Remote images stay blocked until the reader
// presses "Load images", which asks for a new render that routes them through the image proxy
// (PST-REQ-082) — the browser itself never contacts a sender's host.
//
// Height (decided in PST-T-14.6): nothing runs inside the frame, so it cannot report its content
// height (no postMessage), and a content-sized frame is not possible. Instead the pane is a flex
// column — subject and toolbar fixed at the top, one scroller below — and the frame's height is
// layout, not measurement:
//   - a lone HTML message, and the NEWEST message of a thread when it is HTML, fill: the frame is flex: 1 of whatever
//     height is left under its header (min 20rem, so a tall stack of notes still leaves it usable).
//     With the earlier messages collapsed to 44px cards — the default — the pane itself does not
//     scroll; a long message scrolls inside the frame and only there.
//   - an EARLIER message a reader expands by hand gets a fixed clamp(16rem, 50vh, 36rem) frame, so
//     opening an old newsletter in a thread never pushes the latest reply a whole screen away.
// The Newsletters feed (Feed.tsx) sizes each frame from the server's height estimate (PST-T-17.3).
//
// When the server has no usercontent origin configured (503), the text/plain part is shown instead
// and an HTML-only message says so.
//
// No white box (PST-T-15.12): the ticket is asked for in the app's resolved theme and says whether
// the HTML is "designed" (paints its own page). A plain message — most personal mail — renders on a
// transparent page in the app's ink, and its frame has no border, radius or background, flush with
// the text around it. A designed one keeps its own white page, framed by a radius-lg hairline and no
// shadow. A theme change asks for a fresh ticket, so the frame reloads in the new theme.
import { forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ForwardedRef, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Avatar, Button, EmptyState, Modal, ModalClose, Skeleton, Stack, useTheme } from '@d3cloud/ui';
import { AttachmentList } from './AttachmentCard';
import { deliveryPhase, isPending, NO_DELIVERY_RECORD_TEXT } from './delivery';
import { PaletteRoleContext } from './CommandPalette';
import { DeliveryEvidence, DeliveryRecipientRow, DeliverySkeleton } from './DeliveryRows';
import { InspectDrawer } from './InspectDrawer';
import { queuePath, resendDraftInput, resendNotes, resendTargets } from './resend';
import { draftPath, mailPath, parseMailRoute } from './route';
import { InviteSection } from '../invites/InviteSection';
import { ReceiptPrompt } from './ReceiptPrompt';
import { wantsReceipt } from './receipt';
import { useMail } from './MailContext';
import { collapsedSummary, isConversation, mightJoinThread, participantsLine, threadRows, toggleRow } from './thread';
import { trackersBlockedNote } from './trackers';
import {
  api,
  ApiError,
  describeError,
  type DeliveryDetail,
  type DeliveryRecipient,
  type Mailbox,
  type MessageBody,
  type MessageDetail,
  type MessageSummary,
  type RenderTicket,
  serverUnreachable,
} from '../api';
import { displayName, header, listDate } from './format';
import { requestInspect } from './keys';
import { snippetOf } from './thread';
import { SessionEnded } from '../screens/states';
import { PhishChip } from './thread/ExceptionChip';
import { MessageHeader } from './thread/MessageHeader';
import { HeaderActions, QuickReply, SubjectBlock } from './thread/ReadingParts';
import { ThreadToolbar, type ToolbarAction } from './thread/ThreadToolbar';
import { absoluteDate, type ListPosition } from './thread/view';
import './thread/thread.css';

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
  onAction: (action: ToolbarAction) => void;
  /** The open message's place in the list ("3 of 48", with up/down); absent or off-list: hidden. */
  position?: ListPosition | null | undefined;
  onRetry: () => void;
  /** Snooze/Unsnooze, placed in the toolbar's icon group (PST-T-11.4, PST-T-14.6). */
  snooze?: ReactNode;
  /** Moves a message a phishing warning is about to Junk; absent when there is no Junk mailbox. */
  onMoveToJunk?: ((message: MessageDetail) => void) | undefined;
  /** Moves the open message: Not junk and Rescue (to Inbox) and ⋯ Move to… (PST-T-14.6). */
  onMoveTo?: ((message: MessageDetail, to: Mailbox) => void) | undefined;
  /** Opens a draft in the composer; Drafts' toolbar leads with Edit draft only when this is given. */
  onEditDraft?: ((message: MessageDetail) => void) | undefined;
  /** PST-T-14.7: a reply or forward, composed inline under the thread it answers (TF-08). */
  composer?: ReactNode;
  children?: ReactNode;
}

export const ReadingPane = forwardRef<HTMLHeadingElement, ReadingPaneProps>(function ReadingPane(
  { open, back, canArchive, canTrash, onAction, onRetry, snooze, onMoveToJunk, onMoveTo, onEditDraft, composer, position, children },
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
          {serverUnreachable('Check your connection.')}
        </EmptyState>
      </section>
    );
  }

  const { detail, body, bodyStatus } = open;
  const subject = detail.subject === null || detail.subject === '' ? '(no subject)' : detail.subject;

  return (
    <article className="pr-reader pr-reader--open" aria-labelledby="pr-reader-subject" data-message-id={detail.id}>
      {back}
      <ThreadToolbar detail={detail} canArchive={canArchive} canTrash={canTrash} onAction={onAction} onMoveTo={onMoveTo} onEditDraft={onEditDraft} snooze={snooze} position={position} />
      <InspectDrawer messageId={detail.id} />
      {/* One scroller. Keyed by message so j/k gives a short (--dur-1) opacity fade and nothing more. */}
      <div key={detail.id} className="pr-reader__scroll" data-testid="reader-scroll">
        {children}
        <ThreadConversation
          detail={detail}
          body={body}
          bodyStatus={bodyStatus}
          onRetry={onRetry}
          onMoveToJunk={onMoveToJunk}
          onAction={onAction}
          subject={subject}
          headingRef={headingRef}
          fallback={
            <MessageContent detail={detail} body={body} bodyStatus={bodyStatus} onRetry={onRetry} onMoveToJunk={onMoveToJunk} onAction={onAction} isOpen fill={body !== null && body.html !== null} />
          }
        />
        {composer === undefined || composer === null ? <QuickReply detail={detail} body={body} onAction={onAction} /> : composer}
      </div>
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
  onMoveToJunk,
  onAction,
  subject,
  headingRef,
  fallback,
}: {
  detail: MessageDetail;
  body: MessageBody | null;
  bodyStatus: OpenMessage['bodyStatus'];
  onRetry: () => void;
  onMoveToJunk?: ((message: MessageDetail) => void) | undefined;
  onAction: (action: ToolbarAction) => void;
  /** The open message's subject, for the heading. */
  subject: string;
  headingRef: ForwardedRef<HTMLHeadingElement>;
  fallback: ReactNode;
}): ReactNode {
  const { subscribe, me } = useMail();
  // `detail.threadId` is whatever MailView last fetched, which can be stale: a message's very first
  // reply backfills ITS threadId server-side (packages/threading's orphan step) at the moment the
  // reply is sent, but nothing forces MailView to refetch the still-open original afterwards. This
  // component's own mount is the moment to ask again, so a remount (Composer closing back to it,
  // exactly when a reply was just sent) always gets the current answer rather than the stale null.
  const [threadId, setThreadId] = useState<string | null>(detail.threadId);
  const [thread, setThread] = useState<MessageSummary[] | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [extra, setExtra] = useState<ReadonlyMap<string, ExtraMessage>>(new Map());
  // PST-T-11.4: a collapsed row's sender name and first line, from its body (fetched once per row).
  const [previews, setPreviews] = useState<ReadonlyMap<string, MessageBody | null>>(new Map());

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
    setPreviews(new Map());
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

  // Bodies for the collapsed rows' previews: a thread is a handful of messages, and each body is
  // asked for once. A row that is expanded later reuses its own fetch (extra) instead.
  const collapsedKey = rows.filter((r) => !r.expanded).map((r) => r.message.id).join(',');
  useEffect(() => {
    const ids = collapsedKey === '' ? [] : collapsedKey.split(',');
    let cancelled = false;
    for (const id of ids) {
      if (previews.has(id)) continue;
      setPreviews((prev) => (prev.has(id) ? prev : new Map(prev).set(id, null)));
      api.messageBody(id).then(
        (b) => {
          if (!cancelled) setPreviews((prev) => new Map(prev).set(id, b));
        },
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
    // collapsedKey (a joined string) is the real dependency, as with expandedKey above.
  }, [collapsedKey]);

  const conversation = thread !== null && isConversation(thread);
  const heading = (
    <SubjectBlock
      subject={subject}
      headingRef={headingRef}
      participants={conversation ? participantsLine(thread, me) : null}
    />
  );
  if (!conversation) {
    return (
      <>
        {heading}
        {fallback}
      </>
    );
  }

  const threadSubject = thread[thread.length - 1]?.subject ?? null;
  const newestId = thread[thread.length - 1]?.id ?? null;

  return (
    <>
      {heading}
      <ol aria-label="Conversation" className="pr-thread">
        {rows.map(({ message, expanded }) => {
          const isOpen = message.id === detail.id;
          const rowDetail = isOpen ? detail : (extra.get(message.id)?.detail ?? null);
          const rowBody = isOpen ? body : (extra.get(message.id)?.body ?? null);
          const rowBodyStatus = isOpen ? bodyStatus : (extra.get(message.id)?.bodyStatus ?? 'loading');
          // Only an HTML message fills: a text one is as tall as its words (see the header comment).
          const fill = message.id === newestId && rowBody !== null && rowBody.html !== null;
          // Only a row the reader opened by hand animates in; the rows that start open do not, so
          // moving with j/k never plays an entrance (PST-REQ-192's calm).
          const byHand = toggled.has(message.id);
          return (
            <li key={message.id} className="pr-thread__item" data-message-id={message.id} data-expanded={expanded} data-fill={fill}>
              {expanded ? (
                <Reveal animate={byHand}>
                  {rowDetail === null ? (
                    <Skeleton variant="text" lines={3} />
                  ) : (
                    <MessageContent detail={rowDetail} body={rowBody} bodyStatus={rowBodyStatus} onRetry={onRetry} onMoveToJunk={onMoveToJunk} onAction={onAction} isOpen={isOpen} fill={fill} />
                  )}
                </Reveal>
              ) : (
                <button
                  type="button"
                  className="pr-thread__collapsed"
                  aria-expanded={false}
                  onClick={() => { setToggled((t) => toggleRow(t, message.id)); }}
                >
                  <CollapsedRow message={message} threadSubject={threadSubject} preview={previews.get(message.id) ?? null} />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * Opens its content with height + opacity over --dur-2 (PST-REQ-192) — a grid-rows transition from
 * 0fr to 1fr, so no script measures a height — and takes focus, so the reader lands on the message
 * they opened. `animate` false renders it open at once. Reduced motion: the library's global rule
 * zeroes the duration (PST-REQ-193).
 */
function Reveal({ animate, children }: { animate: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(!animate);
  const [settled, setSettled] = useState(!animate);
  useLayoutEffect(() => {
    if (!animate) return undefined;
    ref.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      setOpen(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [animate]);
  return (
    <div
      ref={ref}
      className="pr-reveal pr-thread__message"
      data-open={open}
      data-settled={settled}
      tabIndex={animate ? -1 : undefined}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget) setSettled(true);
      }}
    >
      <div className="pr-reveal__inner">{children}</div>
    </div>
  );
}

/** A collapsed thread row, one line: avatar, sender name, the first words they wrote, the date. */
function CollapsedRow({ message, threadSubject, preview }: { message: MessageSummary; threadSubject: string | null; preview: MessageBody | null }) {
  const from = header(preview, 'From');
  const sender = from === null ? (message.fromName ?? message.from) : displayName(from);
  const name = collapsedSummary({ from: sender, subject: message.subject }, threadSubject);
  const snippet = snippetOf(preview?.text) ?? message.snippet ?? null;
  return (
    <>
      <Avatar name={sender ?? '?'} size="sm" tint="auto" className="pr-thread__avatar" />
      <span className="pr-thread__collapsed-main">
        <span className="pr-thread__collapsed-summary">{name}</span>
        {snippet === null ? null : <span className="pr-thread__snippet">{snippet}</span>}
      </span>
      <time className="pr-thread__date" dateTime={message.date} title={absoluteDate(message.date)}>
        {listDate(message.date)}
      </time>
    </>
  );
}

// --- One message's content: header, exception chips, body, attachments, delivery -----------------

function MessageContent({
  detail,
  body,
  bodyStatus,
  onRetry,
  onMoveToJunk,
  onAction,
  isOpen,
  fill,
}: {
  detail: MessageDetail;
  body: MessageBody | null;
  bodyStatus: OpenMessage['bodyStatus'];
  onRetry: () => void;
  onMoveToJunk?: ((message: MessageDetail) => void) | undefined;
  /** The toolbar's actions, which act on the open message: its header's Star and Reply. */
  onAction: (action: ToolbarAction) => void;
  /** The open message: the one the Inspect drawer belongs to, so its chips' Details can open it. */
  isOpen: boolean;
  /** This message's HTML frame fills the rest of the pane (a lone message, or a thread's newest). */
  fill: boolean;
}) {
  const { mailboxes } = useMail();
  const use = mailboxes?.find((m) => m.id === detail.mailboxId)?.specialUse;
  const ownMailbox = use === 'sent' || use === 'drafts';
  return (
    <div className="pr-msg" data-fill={fill}>
      {/* Star and Reply act on the open message (MailView's target), so only its header has them. */}
      <MessageHeader detail={detail} body={body} actions={isOpen ? <HeaderActions detail={detail} onAction={onAction} /> : undefined} />
      <PhishChip
        phish={detail.phish}
        inJunk={use === 'junk'}
        onMoveToJunk={onMoveToJunk === undefined ? undefined : () => { onMoveToJunk(detail); }}
        onDetails={isOpen ? (from) => { requestInspect(from); } : undefined}
        from={detail.from}
      />
      {wantsReceipt(detail, body, ownMailbox) ? <ReceiptPrompt key={detail.id} messageId={detail.id} /> : null}
      <InviteSection messageId={detail.id} />
      <div className="pr-msg__body">
        <MessageText body={body} status={bodyStatus} onRetry={onRetry} fill={fill} />
      </div>
      <AttachmentList messageId={detail.id} attachments={body?.attachments} />
      <DeliverySection messageId={detail.id} mailboxId={detail.mailboxId} body={body} />
    </div>
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
function DeliverySection({ messageId, mailboxId, body }: { messageId: string; mailboxId: string; body: MessageBody | null }) {
  const { subscribe, mailboxes } = useMail();
  // Admins get each recipient's row in the outbound queue; the server enforces it regardless.
  const isAdmin = useContext(PaletteRoleContext);
  const location = useLocation();
  const navigate = useNavigate();
  const [resending, setResending] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
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

  // PST-T-16.14: a sent copy's section holds its place while the lookup runs, so what is below it
  // does not jump. (A received message has no delivery to show, and says nothing.)
  if (state.status === 'loading') return inSent ? <DeliverySkeleton /> : null;
  if (state.status === 'error') {
    return (
      <Alert tone="warning" title="The delivery timeline could not be loaded" actions={<Button size="sm" onClick={load}>Try again</Button>}>
        {serverUnreachable('Check your connection.')}
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
  const delivery = state.data;
  const notes = resendNotes(body);
  const anyResend = delivery.recipients.some((r) => r.state === 'bounced' || r.state === 'cancelled');
  // Edit and resend: a new draft with the same Subject and text, to the recipients it failed for, and
  // the composer open on it. Nothing is sent until the reader says so.
  const resend = (recipient: DeliveryRecipient) => {
    if (resending !== null) return;
    // The draft is made from the loaded body; before it arrives there is nothing to copy (PST-T-16.14).
    if (body === null) {
      setResendError('The message is still loading. Try Edit and resend again in a moment.');
      return;
    }
    setResending(recipient.id);
    setResendError(null);
    const input = resendDraftInput({ subject: delivery.message.subject, text: body.text }, resendTargets(delivery.recipients, recipient));
    api.createDraft(input).then(
      (saved) => {
        const route = parseMailRoute(location.pathname, location.search);
        void navigate(route === null ? mailPath(saved.mailboxId, saved.id, 'draft') : draftPath(route, saved.id));
      },
      (error: unknown) => {
        setResending(null);
        setResendError(describeError(error));
      },
    );
  };
  return (
    <section aria-label="Delivery" className="pr-delivery" data-testid="delivery">
      <div className="pr-delivery__top">
        <h3 className="pr-reader__h3">Delivery</h3>
        {/* PST-T-14.1 (CPY-01): the raw replies and the attempt log are evidence, shown in the same
            side sheet as Inspect — for THIS message, which in a thread need not be the open one. */}
        <Modal
          trigger={
            <Button size="sm" variant="ghost" aria-label="Delivery details">
              Details
            </Button>
          }
          title="Delivery details"
          description="Every attempt, with the receiving server's own replies."
          size="lg"
          className="pr-inspect"
          footer={
            <ModalClose>
              <Button type="button">Close</Button>
            </ModalClose>
          }
        >
          <DeliveryEvidence recipients={state.data.recipients} />
        </Modal>
      </div>
      <ul className="pr-delivery__list">
        {state.data.recipients.map((r) => (
          <DeliveryRecipientRow
            key={r.id}
            recipient={r}
            onResend={resend}
            resending={resending === r.id}
            queueTo={isAdmin ? queuePath(delivery.message.id) : null}
          />
        ))}
      </ul>
      {anyResend && notes.length > 0 ? (
        <p className="pr-reader__note" data-testid="resend-note">
          {notes.join(' ')}
        </p>
      ) : null}
      {resendError !== null ? (
        <p className="pr-reader__note" role="alert" data-testid="resend-error">
          {resendError}
        </p>
      ) : null}
    </section>
  );
}

/** The frame's sandbox: popups only, so a link (target=_blank, noopener) opens in a normal tab. No scripts, no same-origin. */
export const MAIL_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/** What the reader is told about blocked remote images; null when there is nothing to say. */
export function blockedImagesNote(ticket: Pick<RenderTicket, 'images' | 'remoteImages'>): string | null {
  if (ticket.images || ticket.remoteImages === 0) return null;
  if (ticket.remoteImages === 1) return "One image comes from the sender's servers. Loading it would tell them you opened this message, so it is blocked.";
  return `${String(ticket.remoteImages)} images come from the sender's servers. Loading them would tell them you opened this message, so they are blocked.`;
}

/** The frame's chrome (PST-T-15.12): a designed message gets the hairline page, a plain one nothing. */
export function frameLook(ticket: Pick<RenderTicket, 'designed'>): 'true' | 'false' {
  return ticket.designed ? 'true' : 'false';
}

type FrameState = { status: 'loading' } | { status: 'ready'; ticket: RenderTicket } | { status: 'unavailable' } | { status: 'error' };

function HtmlFrame({ messageId, fallback, note: lead, fill }: { messageId: string; fallback: ReactNode; note: ReactNode; fill: boolean }) {
  const [images, setImages] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<FrameState>({ status: 'loading' });
  const theme = useTheme().resolved;

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    api.renderMessage(messageId, images, theme).then(
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
  }, [messageId, images, attempt, theme]);

  if (state.status === 'loading') return <Skeleton variant="block" height={160} />;
  if (state.status === 'unavailable') return <>{fallback}</>;
  if (state.status === 'error') {
    return (
      <Alert tone="warning" title="The formatted message could not be shown" actions={<Button size="sm" onClick={() => { setAttempt((n) => n + 1); }}>Try again</Button>}>
        {serverUnreachable('Check your connection.')}
      </Alert>
    );
  }
  const note = blockedImagesNote(state.ticket);
  const trackers = trackersBlockedNote(state.ticket);
  return (
    <div className="pr-frame" data-fill={fill} data-designed={frameLook(state.ticket)}>
      {lead}
      {trackers !== null ? (
        <p className="pr-reader__note" data-testid="trackers-blocked">
          {trackers}. Postroom stripped these before showing the message, so the sender cannot see that you opened it.
        </p>
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
        className="pr-frame__frame"
        src={state.ticket.url}
        sandbox={MAIL_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

function MessageText({ body, status, onRetry, fill }: { body: MessageBody | null; status: OpenMessage['bodyStatus']; onRetry: () => void; fill: boolean }) {
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
      <HtmlFrame key={body.id} messageId={body.id} fallback={fallback} note={lead} fill={fill} />
      {body.htmlTruncated ? <p className="pr-reader__note">This message was cut short. The full message is in its raw form.</p> : null}
    </>
  );
}
