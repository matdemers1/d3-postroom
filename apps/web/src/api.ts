// The web app's one door to the API. Same origin, cookies only, and the CSRF header on every
// state-changing request (the API refuses a non-GET without it).

export interface AuthState {
  setupRequired: boolean;
  oidcConfigured: boolean;
  oidcAvailable: boolean;
  signedIn: boolean;
  account?: { id: string; displayName: string; isAdmin: boolean; totpEnabled: boolean; address: string | null };
  method?: 'password' | 'oidc';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(code);
  }
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
  if (method !== 'GET') headers['x-postroom-csrf'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const code =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `http_${String(res.status)}`;
    throw new ApiError(res.status, code, parsed);
  }
  return parsed as T;
}

export const api = {
  state: () => call<AuthState>('GET', '/api/auth/state'),
  setupBegin: (input: { setupToken: string; displayName: string; login: string; password: string }) =>
    call<{ enrolToken: string; secret: string; otpauthUri: string }>('POST', '/api/auth/setup/begin', input),
  setupComplete: (input: { setupToken: string; enrolToken: string; code: string }) =>
    call<{ ok: true }>('POST', '/api/auth/setup/complete', input),
  signIn: (input: { login: string; password: string }) =>
    call<{ next: 'totp'; challenge: string }>('POST', '/api/auth/signin', input),
  signInTotp: (input: { challenge: string; code: string }) => call<{ next: 'done' }>('POST', '/api/auth/signin/totp', input),
  signOut: () => call<{ ok: true }>('POST', '/api/auth/signout'),
  stepUp: (code: string) => call<{ ok: true }>('POST', '/api/auth/step-up', { code }),
  changePassword: (input: { currentPassword: string; newPassword: string; code: string; endOtherSessions?: boolean }) =>
    call<{ ok: true; endedSessions: number }>('POST', '/api/auth/password', input),
  sessions: () => call<{ sessions: AccountSession[] }>('GET', '/api/auth/sessions'),
  endSession: (id: string) => call<{ ok: true }>('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`),
  adminSessions: () => call<{ sessions: AdminSession[] }>('GET', '/api/admin/sessions'),
  revokeSession: (id: string) => call<{ ok: true }>('DELETE', `/api/admin/sessions/${encodeURIComponent(id)}`),
  adminHealth: () => call<{ tiles: HealthTile[] }>('GET', '/api/admin/health'),
  // PST-T-7.1 (PST-REQ-122): DMARC aggregate and TLS-RPT reports, charted on Deliverability.
  adminDeliverability: (days: number) => call<Deliverability>('GET', `/api/admin/deliverability?days=${String(days)}`),
  adminJobs: (opts: { status?: string; queue?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.status !== undefined) q.set('status', opts.status);
    if (opts.queue !== undefined) q.set('queue', opts.queue);
    const qs = q.toString();
    return call<{ jobs: AdminJob[] }>('GET', `/api/admin/jobs${qs === '' ? '' : `?${qs}`}`);
  },
  replayJob: (id: string) => call<{ ok: true }>('POST', `/api/admin/jobs/${encodeURIComponent(id)}/replay`),
  replayInbound: (inboundMessageId: string, fromStage: InboundStage) =>
    call<{ ok: true; jobId: string; fromStage: InboundStage }>('POST', `/api/admin/jobs/inbound/${encodeURIComponent(inboundMessageId)}/replay`, { fromStage }),
  adminQueue: (opts: { domain?: string; state?: QueueStateFilter; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.domain !== undefined) q.set('domain', opts.domain);
    if (opts.state !== undefined) q.set('state', opts.state);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return call<{ messages: AdminQueueMessage[]; sesConfigured: boolean }>('GET', `/api/admin/queue${qs === '' ? '' : `?${qs}`}`);
  },
  queueRetry: (scope: QueueScope) => call<{ ok: true; count: number }>('POST', `${queuePath(scope)}/retry`),
  queueForceSes: (scope: QueueScope) => call<{ ok: true; count: number; transport: 'ses' }>('POST', `${queuePath(scope)}/force-ses`),
  queueBounce: (scope: QueueScope) => call<{ ok: true; count: number }>('POST', `${queuePath(scope)}/bounce`),
  queueDelete: (scope: QueueScope, reason: string) => call<{ ok: true; count: number }>('DELETE', queuePath(scope), { reason }),
  appPasswords: () => call<{ appPasswords: AppPassword[] }>('GET', '/api/app-passwords'),
  createAppPassword: (input: { label: string; scopes: AppPasswordScope[] }) =>
    call<AppPassword & { password: string }>('POST', '/api/app-passwords', input),
  revokeAppPassword: (id: string) => call<{ ok: true }>('DELETE', `/api/app-passwords/${encodeURIComponent(id)}`),

  // --- Mail (PST-T-3.9's API) ---------------------------------------------------------------
  mailboxes: () => call<{ mailboxes: Mailbox[] }>('GET', '/api/mailboxes'),
  messages: (mailboxId: string, opts: { cursor?: string | null; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.cursor !== undefined && opts.cursor !== null) q.set('cursor', opts.cursor);
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return call<MessagePage>('GET', `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages${qs === '' ? '' : `?${qs}`}`);
  },
  message: (id: string) => call<MessageDetail>('GET', `/api/messages/${encodeURIComponent(id)}`),
  messageBody: (id: string) => call<MessageBody>('GET', `/api/messages/${encodeURIComponent(id)}/body`),
  /** A short-lived URL of the sanitised HTML on the usercontent origin (PST-T-3.12). 503 when that origin is not configured. */
  renderMessage: (id: string, images: boolean) => call<RenderTicket>('GET', renderPath(id, images)),
  /** Flags and/or a move. `modseq` is the row's current MODSEQ: the server answers 412 if it moved on. A move returns a NEW id. */
  patchMessage: (id: string, modseq: string, patch: MessagePatch) =>
    call<MessageDetail>('PATCH', `/api/messages/${encodeURIComponent(id)}`, patch, { 'if-match': `"${modseq}"` }),
  thread: (id: string) => call<ThreadDetail>('GET', `/api/threads/${encodeURIComponent(id)}`),
  /** The caller's outbound queue rows, newest first (PST-T-1.13) — keyed by OutboundMessage.id,
   *  which is NOT a mailbox message's own id; ReadingPane matches one to the other by Message-ID
   *  header (see mail/delivery.ts's matchingOutbound). */
  outboundMessages: (opts: { limit?: number; cursor?: string | null } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts.cursor !== undefined && opts.cursor !== null) q.set('cursor', opts.cursor);
    const qs = q.toString();
    return call<{ messages: OutboundListItem[]; nextCursor: string | null }>('GET', `/api/messages/outbound${qs === '' ? '' : `?${qs}`}`);
  },
  /** Per-recipient delivery state and attempt log for one outbound message (PST-T-6.4, PST-REQ-119). */
  messageDelivery: (outboundId: string) => call<DeliveryDetail>('GET', `/api/messages/${encodeURIComponent(outboundId)}/delivery`),
  /** A mailbox message's own OutboundMessage id, or null (PST-T-6.7, PST-REQ-119) — an indexed
   *  server-side lookup by Message-ID header, replacing the client-side scan over recent sends. */
  messageOutbound: (id: string) => call<{ outboundId: string | null }>('GET', `/api/messages/${encodeURIComponent(id)}/outbound`),
  search: (q: string, opts: { mailboxId?: string; cursor?: string | null } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.mailboxId !== undefined) params.set('mailboxId', opts.mailboxId);
    if (opts.cursor !== undefined && opts.cursor !== null) params.set('cursor', opts.cursor);
    return call<MessagePage>('GET', `/api/search?${params.toString()}`);
  },

  // --- Compose (PST-T-3.11) -------------------------------------------------------------------
  /** Through the submission path; filed in Sent and threaded before it answers. */
  send: (input: SendInput) => call<SendResult>('POST', '/api/compose/send', input),
  createDraft: (input: DraftInput) => call<DraftSaved>('POST', '/api/compose/drafts', input),
  /** Replaces the draft: the answer carries its NEW id. */
  replaceDraft: (id: string, input: DraftInput) => call<DraftSaved>('PUT', `/api/compose/drafts/${encodeURIComponent(id)}`, input),
  draft: (id: string) => call<SavedDraft>('GET', `/api/compose/drafts/${encodeURIComponent(id)}`),
  drafts: (opts: { inReplyTo?: string } = {}) =>
    call<{ drafts: SavedDraft[] }>('GET', `/api/compose/drafts${opts.inReplyTo === undefined ? '' : `?${new URLSearchParams({ inReplyTo: opts.inReplyTo }).toString()}`}`),
  deleteDraft: (id: string) => call<null>('DELETE', `/api/compose/drafts/${encodeURIComponent(id)}`),

  // --- Held sends and snooze (PST-T-9.1) ------------------------------------------------------------
  /** With undoSeconds > 0 or sendAt the answer is a held send (202), not a SendResult. */
  sendOrHold: (input: SendInput) => call<SendResult | PendingSend>('POST', '/api/compose/send', input),
  pendingSends: () => call<{ pending: PendingSend[] }>('GET', '/api/compose/pending'),
  undoSend: (id: string) => call<PendingSend>('POST', `/api/compose/pending/${encodeURIComponent(id)}/undo`, {}),
  reschedule: (id: string, sendAt: string) => call<PendingSend>('PATCH', `/api/compose/pending/${encodeURIComponent(id)}`, { sendAt }),
  snoozeThread: (threadId: string, until: string) => call<Snooze>('POST', `/api/threads/${encodeURIComponent(threadId)}/snooze`, { until }),
  unsnoozeThread: (threadId: string) => call<Snooze>('DELETE', `/api/threads/${encodeURIComponent(threadId)}/snooze`),
};

/** The render-ticket request: remote images only when the reader chose to load them (PST-REQ-082). */
export const renderPath = (messageId: string, images: boolean): string =>
  `/api/messages/${encodeURIComponent(messageId)}/render${images ? '?images=1' : ''}`;

/** Where an attachment downloads from: always a download, never rendered on this origin. */
export const attachmentUrl = (messageId: string, partId: string): string =>
  `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`;
export const rawMessageUrl = (messageId: string): string => `/api/messages/${encodeURIComponent(messageId)}/raw`;
/** The SSE stream (PST-REQ-083). */
export const EVENTS_URL = '/api/events';

export type ComposeKind = 'new' | 'reply' | 'replyall' | 'forward';

/** What the composer sends and saves. Address fields are entries ("Name <a@b>"), one per address. */
export interface ComposeFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string[];
  /** Forward: the message attached whole (message/rfc822). */
  forwardOf: string | null;
}

export interface SendInput extends ComposeFields {
  from: string;
  /** The draft this send replaces; removed from Drafts with the send. */
  draftId: string | null;
  /** Undo send: hold this many seconds (0–30) before queueing (PST-T-9.1). */
  undoSeconds?: number;
  /** Scheduled send: an ISO time in the future. */
  sendAt?: string;
  /** Remind if no reply after this many seconds. */
  remindAfterSeconds?: number;
}

/** A held send: undo window or scheduled (PST-T-9.1). */
export interface PendingSend {
  id: string;
  kind: 'undo' | 'scheduled';
  state: 'held' | 'released' | 'cancelled' | 'failed';
  releaseAt: string;
  draftId: string | null;
  subject: string;
  to: string;
  messageId: string;
  remindAfterSeconds: number | null;
  reason: string | null;
  createdAt: string;
}

export interface Snooze {
  id: string;
  threadId: string;
  until: string;
  state: 'snoozed' | 'returned' | 'unsnoozed';
  mailboxId: string;
  messageIds: string[];
}

export interface SendResult {
  messageId: string;
  outboundId: string;
  sentMessageId: string;
  sentMailboxId: string;
  threadId: string | null;
}

export interface DraftInput extends ComposeFields {
  from?: string;
  mode: ComposeKind | null;
  sourceId: string | null;
}

export interface DraftSaved {
  id: string;
  mailboxId: string;
  uid: number;
  savedAt: string;
}

export interface SavedDraft extends ComposeFields {
  id: string;
  mailboxId: string;
  from: string;
  mode: ComposeKind | null;
  sourceId: string | null;
  savedAt: string;
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'rejects';

export interface Mailbox {
  id: string;
  name: string;
  specialUse: SpecialUse | null;
  uidvalidity: number;
  uidnext: number;
  /** A decimal string: MODSEQs outgrow a JSON number. */
  highestModseq: string;
  subscribed: boolean;
  total: number;
  unseen: number;
}

export interface MessageSummary {
  id: string;
  mailboxId: string;
  uid: number;
  modseq: string;
  threadId: string | null;
  subject: string | null;
  /** The sender's address (denormalised at filing); the display name is in the body's headers. */
  from: string | null;
  date: string;
  internalDate: string;
  size: number;
  flags: string[];
  bucket: string | null;
}

export interface MessagePage {
  messages: MessageSummary[];
  nextCursor: string | null;
}

/** One phishing/lookalike warning (PST-T-6.5, PST-REQ-120): `reason` is the full, human-readable text to show — never just the kind. */
export interface PhishWarning {
  kind: 'display-name-spoofing' | 'lookalike-domain' | 'punycode-domain' | 'first-time-brand-sender' | 'auth-failure' | 'link-mismatch';
  severity: 'low' | 'medium' | 'high';
  reason: string;
}

export interface Phish {
  warnings: PhishWarning[];
}

export interface MessageDetail extends MessageSummary {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  verdict: { bucket: string | null; reasons: string[]; auth: unknown } | null;
  /** Null when there is nothing to check yet (no stored auth verdict). */
  phish: Phish | null;
}

export interface MessageAttachment {
  partId: string;
  contentType: string;
  filename: string | null;
  disposition: string | null;
  contentId: string | null;
  size: number;
  sha256: string;
  inMessage: string | null;
}

export interface MessageBody {
  id: string;
  headers: { name: string; value: string }[];
  text: string | null;
  textTruncated: boolean;
  /** Raw and UNSANITISED. Never put it in this document: PST-T-3.12 renders it on the usercontent origin. */
  html: string | null;
  htmlTruncated: boolean;
  attachments: MessageAttachment[];
  warnings: { code: string; message: string; partId: string | null }[];
}

/** Where a message's HTML is rendered: a capability URL on the usercontent origin, for a sandboxed frame. */
export interface RenderTicket {
  url: string;
  expiresAt: string;
  images: boolean;
  /** Remote images in the message; above 0 with images false means they are blocked. */
  remoteImages: number;
  /** Known tracking pixels removed before rendering (PST-REQ-116); never loaded, even with images on. */
  trackersBlocked: number;
  /** Links whose tracking parameters were stripped or whose click-redirect wrapper was unwrapped. */
  linksCleaned: number;
}

export interface MessagePatch {
  flags?: { add?: string[]; remove?: string[] };
  mailboxId?: string;
}

export interface ThreadDetail {
  id: string;
  subject: string | null;
  messageCount: number;
  lastMessageAt: string;
  messages: MessageSummary[];
}

/** Matches apps/api/src/delivery/index.ts's attemptJson (PST-T-6.4). */
export interface DeliveryAttemptView {
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  transport: string;
  mxHost: string | null;
  mxIp: string | null;
  localIp: string | null;
  tls: { version: string | null; cipher: string | null; peer: string | null };
  remote: { code: number | null; enhanced: string | null; text: string | null };
  outcome: string;
  error: string | null;
}

/** Matches @postroom/db's RecipientState enum. */
export type DeliveryState = 'queued' | 'attempting' | 'deferred' | 'delivered' | 'bounced' | 'cancelled';

/** Matches apps/api/src/delivery/index.ts's recipientJson. */
export interface DeliveryRecipient {
  id: string;
  address: string;
  state: DeliveryState;
  attempts: number;
  nextAttemptAt: string;
  lastCode: number | null;
  lastEnhanced: string | null;
  lastText: string | null;
  deliveredAt: string | null;
  dsn: { delaySentAt: string | null; failureSentAt: string | null };
  transport: string;
  attemptsLog: DeliveryAttemptView[];
}

/** Matches apps/api/src/delivery/index.ts's messageJson. */
export interface DeliveryMessage {
  id: string;
  subject: string | null;
  headerFrom: string;
  messageId: string | null;
  createdAt: string;
  size: number;
}

export interface DeliveryDetail {
  message: DeliveryMessage;
  recipients: DeliveryRecipient[];
}

/** Matches GET /api/messages/outbound's row shape (apps/api/src/delivery/index.ts). */
export interface OutboundListItem {
  id: string;
  subject: string | null;
  headerFrom: string;
  messageId: string | null;
  createdAt: string;
  size: number;
  recipients: { id: string; address: string; state: DeliveryState; lastText: string | null }[];
}

export interface MailboxChangedEvent {
  mailboxId: string;
  uidnext: number;
  highestModseq: string;
  unseen: number;
  total: number;
}

export interface MessageNewEvent {
  mailboxId: string;
  messageId: string;
  uid: number;
  subject: string | null;
  from: string | null;
  date: string;
}

export type AppPasswordScope = 'imap' | 'smtp' | 'dav' | 'sieve';

/** An app password as the API lists it. The plaintext is only ever in the create response. */
export interface AppPassword {
  id: string;
  accountId: string;
  label: string;
  prefix: string;
  scopes: AppPasswordScope[];
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  dailyRecipientCap: number | null;
  frozenAt: string | null;
}

/** One of the caller's own live sessions, as GET /api/auth/sessions lists it (PST-REQ-091). */
export interface AccountSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface AdminSession {
  id: string;
  accountId: string;
  displayName: string;
  method: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export type HealthTileState = 'ok' | 'warn' | 'down' | 'unknown';

export interface HealthTile {
  id: string;
  label: string;
  state: HealthTileState;
  detail: string;
  since: string | null;
}

/** Matches apps/api/src/admin-jobs/index.ts's STAGES. */
export const INBOUND_STAGES = ['verify', 'parse', 'classify', 'sieve', 'file', 'notify'] as const;
export type InboundStage = (typeof INBOUND_STAGES)[number];

/** Matches apps/api/src/admin-queue/index.ts's ListQuery. */
export type QueueStateFilter = 'pending' | 'deferred' | 'held' | 'failed';

export type QueueScope = { kind: 'recipient' | 'message'; id: string } | { kind: 'domain'; domain: string };

export function queuePath(scope: QueueScope): string {
  if (scope.kind === 'domain') return `/api/admin/queue/domains/${encodeURIComponent(scope.domain)}`;
  return `/api/admin/queue/${scope.kind === 'recipient' ? 'recipients' : 'messages'}/${encodeURIComponent(scope.id)}`;
}

export interface AdminQueueRecipient {
  id: string;
  outboundMessageId: string;
  address: string;
  domain: string;
  state: string;
  transport: string;
  attempts: number;
  nextAttemptAt: string;
  lastCode: number | null;
  lastEnhanced: string | null;
  lastText: string | null;
  updatedAt: string;
  lastAttempt: { startedAt: string; outcome: string; error: string | null } | null;
}

export interface AdminQueueMessage {
  id: string;
  subject: string | null;
  headerFrom: string;
  envelopeFrom: string;
  createdAt: string;
  recipients: AdminQueueRecipient[];
}

export interface AdminJob {
  id: string;
  queue: string;
  status: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Where a path must go for this auth state, or null to render it. Pure, so it is unit-tested. */
export function redirectFor(state: AuthState, pathname: string): string | null {
  if (state.setupRequired) return pathname === '/setup' ? null : '/setup';
  if (pathname === '/setup') return '/signin';
  if (!state.signedIn) return pathname === '/signin' ? null : '/signin';
  if (pathname === '/signin') return '/';
  if (pathname.startsWith('/admin') && state.account?.isAdmin !== true) return '/';
  return null;
}

/** Password policy problem codes, in the order password-policy.ts reports them (PST-T-4.3). */
type PasswordProblem = 'too_short' | 'too_long' | 'common' | 'context_word';

const PASSWORD_PROBLEM_LABEL: Record<PasswordProblem, string> = {
  too_short: 'must be at least 12 characters',
  too_long: 'must be at most 1024 characters',
  common: 'is one of the most common breached passwords',
  context_word: "is built on Postroom's own name — choose something unrelated",
};

/** Which rule a refused password failed, from the `weak_password` response body's `problems`. */
function describeWeakPassword(body: unknown): string {
  const problems =
    typeof body === 'object' && body !== null && Array.isArray((body as { problems?: unknown }).problems)
      ? ((body as { problems: unknown[] }).problems.filter((p): p is PasswordProblem => typeof p === 'string' && p in PASSWORD_PROBLEM_LABEL))
      : [];
  if (problems.length === 0) return 'That password is too weak. Choose another.';
  return `That password ${problems.map((p) => PASSWORD_PROBLEM_LABEL[p]).join('; ')}.`;
}

/** A human sentence for an API refusal on the sign-in, setup and account-security screens. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Postroom did not answer. Check your connection and try again.';
  switch (error.code) {
    case 'invalid_credentials':
      return 'Those details did not match.';
    case 'invalid_code':
      return 'That code did not match. Try the current one.';
    case 'challenge_expired':
      return 'That took too long. Sign in again.';
    case 'too_many_attempts':
      return 'Too many attempts. Wait a moment and try again.';
    case 'totp_not_enrolled':
      return 'This account has no authenticator enrolled. Ask the operator to set one up.';
    case 'setup_complete':
      return 'Setup is already complete. Sign in instead.';
    case 'setup_token_required':
      return 'That setup token did not match. Copy SETUP_TOKEN from the server\'s env file.';
    case 'setup_expired':
      return 'Setup took too long. Start again.';
    case 'login_taken':
      return 'That login is already an address here. Choose another.';
    case 'invalid_request':
      return 'Check the highlighted fields.';
    case 'auth_not_configured':
      return 'Sign-in is not configured on this server yet.';
    case 'weak_password':
      return describeWeakPassword(error.body);
    case 'no_password':
      return 'This account signs in with D3 Auth and has no password here to change.';
    case 'step_up_required':
      return 'That needs a fresh authentication code.';
    default:
      return 'Something went wrong. Try again.';
  }
}

// --- IMAP import (PST-T-10.2, PST-REQ-152) ---------------------------------------------------

export type ImportStatusName = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ImportFolderStatus {
  name: string;
  target: string;
  total: number;
  imported: number;
  duplicates: number;
  done: boolean;
}

export interface ImportStatus {
  id: string;
  status: ImportStatusName;
  host: string;
  port: number;
  username: string;
  pinned: boolean;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  cancelRequested: boolean;
  folders: ImportFolderStatus[];
  totals: { folders: number; foldersDone: number; total: number; imported: number; duplicates: number };
}

export interface StartImportInput {
  host: string;
  port: number;
  username: string;
  password: string;
  trustFingerprint?: string;
  folders?: string[];
}

export const importApi = {
  /** The latest import of the caller's, or null. */
  latest: () => call<{ import: ImportStatus | null }>('GET', '/api/import'),
  get: (id: string) => call<ImportStatus>('GET', `/api/import/${encodeURIComponent(id)}`),
  /** Needs a fresh step-up: 403 step_up_required otherwise. 409 import_active while another runs. */
  start: (input: StartImportInput) => call<ImportStatus>('POST', '/api/import', input),
  cancel: (id: string) => call<ImportStatus>('POST', `/api/import/${encodeURIComponent(id)}/cancel`),
};

// --- Mobileconfig (PST-T-8.6) ------------------------------------------------------------------

export interface MobileconfigResult {
  blob: Blob;
  filename: string;
  /** Whether MOBILECONFIG_SIGNING_CERT_FILE was configured on the server: iOS shows Verified vs Unverified. */
  signed: boolean;
}

const FILENAME_RE = /filename="?([^";]+)"?/;

/** Needs a fresh step-up: throws ApiError('step_up_required') otherwise. The body is not JSON, so
 *  this bypasses `call()` to keep it as a Blob rather than trying (and failing) to parse it. */
export async function generateMobileconfig(): Promise<MobileconfigResult> {
  const res = await fetch('/api/mobileconfig', {
    method: 'POST',
    headers: { 'x-postroom-csrf': '1' },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    const code =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : `http_${String(res.status)}`;
    throw new ApiError(res.status, code, parsed);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = FILENAME_RE.exec(disposition)?.[1] ?? 'postroom.mobileconfig';
  const signed = res.headers.get('x-postroom-mobileconfig-signed') === '1';
  const blob = await res.blob();
  return { blob, filename, signed };
}

// --- Sieve rules (PST-T-9.5, PST-REQ-150) ------------------------------------------------------

export interface SieveScriptSummary {
  name: string;
  active: boolean;
  size: number;
  updatedAt: string;
}

export interface SieveScript extends SieveScriptSummary {
  content: string;
}

/** A compile error: 1-based line and column, and the message (which starts "line L, column C: "). */
export interface SieveCompileError {
  line: number;
  column: number;
  message: string;
}

export interface SieveScriptList {
  scripts: SieveScriptSummary[];
  extensions: string[];
  maxScripts: number;
  maxScriptBytes: number;
}

const scriptPath = (name: string): string => `/api/sieve/scripts/${encodeURIComponent(name)}`;

export const sieveApi = {
  list: () => call<SieveScriptList>('GET', '/api/sieve/scripts'),
  get: (name: string) => call<SieveScript>('GET', scriptPath(name)),
  /** 422 invalid_script (body.compileError has the line) when it does not compile. */
  put: (name: string, content: string) => call<SieveScriptSummary>('PUT', scriptPath(name), { content }),
  /** 409 script_active for the active script. */
  remove: (name: string) => call<{ ok: true }>('DELETE', scriptPath(name)),
  activate: (name: string) => call<{ ok: true }>('POST', `${scriptPath(name)}/activate`),
  deactivate: () => call<{ ok: true }>('POST', '/api/sieve/deactivate'),
  check: (content: string) => call<{ valid: boolean; error: SieveCompileError | null }>('POST', '/api/sieve/check', { content }),
};

/** The compile error in a refused save, if that is why it was refused. */
export function compileErrorOf(error: unknown): SieveCompileError | null {
  if (!(error instanceof ApiError) || error.code !== 'invalid_script') return null;
  const body = error.body as { compileError?: SieveCompileError } | null;
  return body?.compileError ?? null;
}

// --- Calendar and contacts (PST-T-8.5) --------------------------------------------------------
// Writes go through the same DAV store an iPhone syncs with. Edits carry the etag last read as
// If-Match: a 412 means the phone changed it since, and the screen reloads rather than overwrite.

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface Calendar {
  id: string;
  displayName: string;
  color: string | null;
  components: string[];
  canHoldEvents: boolean;
}

export interface RecurrenceInput {
  freq: Frequency;
  interval: number;
  byDay: Weekday[];
  count: number | null;
  until: string | null;
}

export interface EventInput {
  summary: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
  timezone: string;
  /** Omitted on an update: keep the series' rule as stored. */
  recurrence?: RecurrenceInput | null;
}

export interface EventInstance {
  calendarId: string;
  name: string;
  etag: string;
  uid: string;
  recurrenceId: string;
  start: string;
  end: string;
  allDay: boolean;
  startDay: string | null;
  endDay: string | null;
  summary: string;
  location: string;
  recurring: boolean;
  override: boolean;
}

export interface EventDetail {
  calendarId: string;
  name: string;
  etag: string;
  uid: string;
  summary: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
  timezone: string | null;
  recurrence: { freq: string; interval: number; byDay: string[]; count: number | null; until: string | null; rule: string; editable: boolean } | null;
  overrides: string[];
  exdates: string[];
}

export interface EventSaved {
  calendarId: string;
  name: string;
  uid: string;
  etag: string;
}

const eventPath = (calendarId: string, name: string): string =>
  `/api/calendar/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(name)}`;
const ifMatch = (etag: string): Record<string, string> => ({ 'if-match': `"${etag}"` });

export const calendarApi = {
  calendars: () => call<{ calendars: Calendar[] }>('GET', '/api/calendar/calendars'),
  events: (range: { start: string; end: string; tz: string; calendarId?: string }) =>
    call<{ instances: EventInstance[]; truncated: boolean }>('GET', `/api/calendar/events?${new URLSearchParams(range).toString()}`),
  event: (calendarId: string, name: string) => call<EventDetail>('GET', eventPath(calendarId, name)),
  create: (calendarId: string, input: EventInput) => call<EventSaved>('POST', `/api/calendar/calendars/${encodeURIComponent(calendarId)}/events`, input),
  update: (calendarId: string, name: string, etag: string, input: EventInput) => call<EventSaved>('PUT', eventPath(calendarId, name), input, ifMatch(etag)),
  remove: (calendarId: string, name: string, etag: string) => call<null>('DELETE', eventPath(calendarId, name), undefined, ifMatch(etag)),
  updateInstance: (calendarId: string, name: string, recurrenceId: string, etag: string, input: Omit<EventInput, 'recurrence'>) =>
    call<EventSaved>('PUT', `${eventPath(calendarId, name)}/instances/${encodeURIComponent(recurrenceId)}`, input, ifMatch(etag)),
  removeInstance: (calendarId: string, name: string, recurrenceId: string, etag: string) =>
    call<EventSaved>('DELETE', `${eventPath(calendarId, name)}/instances/${encodeURIComponent(recurrenceId)}`, undefined, ifMatch(etag)),
};

export interface AddressBook {
  id: string;
  displayName: string;
  slug: string;
  count: number;
}

export interface ContactSummary {
  addressBookId: string;
  name: string;
  etag: string;
  uid: string;
  displayName: string;
  emails: string[];
  org: string;
  hasPhoto: boolean;
}

export interface ContactInput {
  fn: string;
  given: string;
  family: string;
  emails: { address: string; type: string | null }[];
  tels: { value: string; type: string | null }[];
  org: string;
  note: string;
}

export interface ContactDetail extends ContactInput {
  addressBookId: string;
  name: string;
  etag: string;
  uid: string;
  displayName: string;
  hasPhoto: boolean;
}

export interface ContactSaved {
  addressBookId: string;
  name: string;
  uid: string;
  etag: string;
}

const cardPath = (addressBookId: string, name: string): string =>
  `/api/contacts/address-books/${encodeURIComponent(addressBookId)}/cards/${encodeURIComponent(name)}`;

export const contactsApi = {
  addressBooks: () => call<{ addressBooks: AddressBook[] }>('GET', '/api/contacts/address-books'),
  list: (opts: { q?: string; addressBookId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.q !== undefined && opts.q.trim() !== '') q.set('q', opts.q.trim());
    if (opts.addressBookId !== undefined) q.set('addressBookId', opts.addressBookId);
    const qs = q.toString();
    return call<{ contacts: ContactSummary[]; truncated: boolean }>('GET', `/api/contacts${qs === '' ? '' : `?${qs}`}`);
  },
  lookup: (address: string) =>
    call<{ contact: { addressBookId: string; name: string; displayName: string } | null }>('GET', `/api/contacts/lookup?${new URLSearchParams({ address }).toString()}`),
  get: (addressBookId: string, name: string) => call<ContactDetail>('GET', cardPath(addressBookId, name)),
  create: (addressBookId: string, input: ContactInput) =>
    call<ContactSaved>('POST', `/api/contacts/address-books/${encodeURIComponent(addressBookId)}/cards`, input),
  update: (addressBookId: string, name: string, etag: string, input: ContactInput) => call<ContactSaved>('PUT', cardPath(addressBookId, name), input, ifMatch(etag)),
  remove: (addressBookId: string, name: string, etag: string) => call<null>('DELETE', cardPath(addressBookId, name), undefined, ifMatch(etag)),
};

/** The contacts screen's URL for one card (the reading pane's sender link). */
export const contactPath = (addressBookId: string, name: string): string =>
  `/contacts/${encodeURIComponent(addressBookId)}/${encodeURIComponent(name)}`;

// ─── Deliverability (PST-T-7.1, PST-REQ-122) ─────────────────────────────────────────────────────

export interface DeliverabilitySource {
  sourceIp: string;
  reverseDns: string | null;
  messages: number;
  pass: number;
  fail: number;
  passRate: number;
  dkimPass: number;
  spfPass: number;
  orgs: string[];
  headerFrom: string[];
}

export interface Deliverability {
  range: { from: string; to: string; days: number };
  mailboxes: { dmarc: string | null };
  dmarc: {
    totals: { reports: number; messages: number; pass: number; fail: number; dkimPass: number; spfPass: number; dispositions: { none: number; quarantine: number; reject: number } };
    byDay: { day: string; pass: number; fail: number }[];
    bySource: DeliverabilitySource[];
    byOrg: { org: string; reports: number; messages: number; pass: number; fail: number }[];
    reports: { id: string; org: string; reportId: string; domain: string; begin: string; end: string; messages: number }[];
  };
  tlsrpt: {
    totals: { reports: number; successful: number; failed: number };
    byPolicy: { policyDomain: string; policyType: string; successful: number; failed: number }[];
    byFailureType: { resultType: string; sessions: number }[];
    reports: { id: string; org: string; reportId: string; begin: string; end: string; successful: number; failed: number }[];
  };
}
