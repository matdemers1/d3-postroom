// Learn mode (PST-T-6.1, PST-REQ-115): every header, reply code and verdict in the Inspect drawer can
// link to the RFC section that defines it. Pure data plus lookups, unit-tested in
// test/unit/rfc-links.test.ts. The links are plain <a> elements the reader opens: the app never
// fetches rfc-editor.org itself (PST-REQ-159).
//
// URL form: https://www.rfc-editor.org/rfc/rfcNNNN#section-X.Y — the anchors rfc-editor.org's HTML
// renderings carry for every numbered section.
//
// Sources for the section numbers (each checked against the RFC's table of contents):
//   RFC 5321  §4.2 SMTP Replies (§4.2.3 numeric list), §4.4 Trace Information
//   RFC 5322  §3.6.1 Date, §3.6.2 originator (From/Sender/Reply-To), §3.6.3 destination (To/Cc/Bcc),
//             §3.6.4 identification (Message-ID/In-Reply-To/References), §3.6.5 informational
//             (Subject/Comments/Keywords), §3.6.6 Resent-*, §3.6.7 trace (Return-Path)
//   RFC 2045  §4 MIME-Version, §5 Content-Type, §6 Content-Transfer-Encoding, §7 Content-ID,
//             §8 Content-Description;  RFC 2183 §2 Content-Disposition
//   RFC 2369  §3.1 List-Help … §3.6 List-Archive;  RFC 8058 §5 Header Syntax (List-Unsubscribe-Post)
//   RFC 3463  §3.1–§3.8 enhanced status code subjects X.0–X.7
//   RFC 3834  §5 Auto-Submitted
//   RFC 3848  §1 ESMTPS/ESMTPA/ESMTPSA transmission types
//   RFC 5782  §2.1 IP address DNSxLs
//   RFC 6376  §3.5 DKIM-Signature, §6 Verifier Actions
//   RFC 7208  §2.6.1–§2.6.7 SPF results, §9.1 Received-SPF
//   RFC 7489  §3.1 Identifier Alignment, §6.3 policy record tags, §6.6 Mail Receiver Actions
//   RFC 8098  §2.1 Disposition-Notification-To, §2.2 Disposition-Notification-Options,
//             §2.3 Original-Recipient
//   RFC 8601  §2.2 Authentication-Results formal definition
//   RFC 8617  §4.1.1 ARC-Authentication-Results, §4.1.2 ARC-Message-Signature, §4.1.3 ARC-Seal,
//             §4.4 Chain Validation Status

export interface RfcRef {
  rfc: number;
  /** Dotted section number, e.g. "4.4". */
  section: string;
  /** What that section defines, for the link's accessible name. */
  title: string;
}

export function rfcUrl(ref: RfcRef): string {
  return `https://www.rfc-editor.org/rfc/rfc${String(ref.rfc)}#section-${ref.section}`;
}

const r = (rfc: number, section: string, title: string): RfcRef => ({ rfc, section, title });

/** Header field name (lower case) → its defining section. */
export const HEADER_REFS: Readonly<Record<string, RfcRef>> = {
  received: r(5321, '4.4', 'Trace information (Received)'),
  'return-path': r(5322, '3.6.7', 'Trace fields (Return-Path)'),
  'authentication-results': r(8601, '2.2', 'Authentication-Results'),
  'dkim-signature': r(6376, '3.5', 'The DKIM-Signature header field'),
  'arc-authentication-results': r(8617, '4.1.1', 'ARC-Authentication-Results'),
  'arc-message-signature': r(8617, '4.1.2', 'ARC-Message-Signature'),
  'arc-seal': r(8617, '4.1.3', 'ARC-Seal'),
  'received-spf': r(7208, '9.1', 'Received-SPF'),
  date: r(5322, '3.6.1', 'The origination date field'),
  from: r(5322, '3.6.2', 'Originator fields'),
  sender: r(5322, '3.6.2', 'Originator fields'),
  'reply-to': r(5322, '3.6.2', 'Originator fields'),
  to: r(5322, '3.6.3', 'Destination address fields'),
  cc: r(5322, '3.6.3', 'Destination address fields'),
  bcc: r(5322, '3.6.3', 'Destination address fields'),
  'message-id': r(5322, '3.6.4', 'Identification fields'),
  'in-reply-to': r(5322, '3.6.4', 'Identification fields'),
  references: r(5322, '3.6.4', 'Identification fields'),
  subject: r(5322, '3.6.5', 'Informational fields'),
  comments: r(5322, '3.6.5', 'Informational fields'),
  keywords: r(5322, '3.6.5', 'Informational fields'),
  'resent-date': r(5322, '3.6.6', 'Resent fields'),
  'resent-from': r(5322, '3.6.6', 'Resent fields'),
  'resent-sender': r(5322, '3.6.6', 'Resent fields'),
  'resent-to': r(5322, '3.6.6', 'Resent fields'),
  'resent-cc': r(5322, '3.6.6', 'Resent fields'),
  'resent-bcc': r(5322, '3.6.6', 'Resent fields'),
  'resent-message-id': r(5322, '3.6.6', 'Resent fields'),
  'mime-version': r(2045, '4', 'MIME-Version header field'),
  'content-type': r(2045, '5', 'Content-Type header field'),
  'content-transfer-encoding': r(2045, '6', 'Content-Transfer-Encoding header field'),
  'content-id': r(2045, '7', 'Content-ID header field'),
  'content-description': r(2045, '8', 'Content-Description header field'),
  'content-disposition': r(2183, '2', 'The Content-Disposition header field'),
  'list-help': r(2369, '3.1', 'List-Help'),
  'list-unsubscribe': r(2369, '3.2', 'List-Unsubscribe'),
  'list-subscribe': r(2369, '3.3', 'List-Subscribe'),
  'list-post': r(2369, '3.4', 'List-Post'),
  'list-owner': r(2369, '3.5', 'List-Owner'),
  'list-archive': r(2369, '3.6', 'List-Archive'),
  'list-unsubscribe-post': r(8058, '5', 'List-Unsubscribe-Post header syntax (one-click)'),
  'auto-submitted': r(3834, '5', 'Auto-Submitted header field'),
  'disposition-notification-to': r(8098, '2.1', 'Disposition-Notification-To (read-receipt request)'),
  'disposition-notification-options': r(8098, '2.2', 'Disposition-Notification-Options'),
  'original-recipient': r(8098, '2.3', 'Original-Recipient'),
};

export function headerRef(name: string): RfcRef | null {
  return HEADER_REFS[name.trim().toLowerCase()] ?? null;
}

/** RFC 5321 §4.2: any three-digit reply code 2xx–5xx. */
export function replyCodeRef(code: number): RfcRef | null {
  if (!Number.isInteger(code) || code < 200 || code > 599) return null;
  return r(5321, '4.2.3', `SMTP reply codes (${String(code)})`);
}

const ENHANCED_SUBJECTS = ['Other or undefined status', 'Address status', 'Mailbox status', 'Mail system status', 'Network and routing status', 'Mail delivery protocol status', 'Message content or media status', 'Security or policy status'];

/** RFC 3463 §3: "class.subject.detail" → the section for its subject (X.n → §3.(n+1)). */
export function enhancedStatusRef(code: string): RfcRef | null {
  const m = /^([245])\.(\d{1,3})\.(\d{1,3})$/.exec(code.trim());
  const subject = m?.[2] === undefined ? NaN : Number(m[2]);
  const title = ENHANCED_SUBJECTS[subject];
  if (title === undefined) return null;
  return r(3463, `3.${String(subject + 1)}`, `Enhanced status code ${code.trim()}: ${title.toLowerCase()}`);
}

/** "250 2.0.0 Queued as …" → links for the reply code and, when present, the enhanced code. */
export function smtpReplyRefs(reply: string): { code: RfcRef | null; enhanced: RfcRef | null; codeText: string | null; enhancedText: string | null } {
  const m = /^(\d{3})(?:[ -]([245]\.\d{1,3}\.\d{1,3}))?/.exec(reply.trim());
  if (m?.[1] === undefined) return { code: null, enhanced: null, codeText: null, enhancedText: null };
  return { code: replyCodeRef(Number(m[1])), codeText: m[1], enhanced: m[2] === undefined ? null : enhancedStatusRef(m[2]), enhancedText: m[2] ?? null };
}

const SPF_RESULTS: Readonly<Record<string, string>> = { none: '2.6.1', neutral: '2.6.2', pass: '2.6.3', fail: '2.6.4', softfail: '2.6.5', temperror: '2.6.6', permerror: '2.6.7' };

export type VerdictKind = 'spf' | 'dkim' | 'dmarc' | 'arc' | 'dnsbl' | 'alignment' | 'dmarc-policy';

/** The section that defines a verdict's result. */
export function verdictRef(kind: VerdictKind, result = ''): RfcRef | null {
  const res = result.trim().toLowerCase();
  switch (kind) {
    case 'spf': {
      const section = SPF_RESULTS[res];
      return section === undefined ? r(7208, '2.6', 'SPF results of evaluation') : r(7208, section, `SPF result "${res}"`);
    }
    case 'dkim':
      return r(6376, '6', 'DKIM verifier actions');
    case 'dmarc':
      return r(7489, '6.6', 'DMARC mail receiver actions');
    case 'dmarc-policy':
      return r(7489, '6.3', 'DMARC policy record tags');
    case 'alignment':
      return r(7489, '3.1', 'DMARC identifier alignment');
    case 'arc':
      return r(8617, '4.4', 'ARC chain validation status');
    case 'dnsbl':
      return r(5782, '2.1', 'IP address DNSxLs');
  }
}

/** RFC 3848: the transmission types that say a hop was encrypted (ESMTPS) or authenticated. */
export const TLS_PROTOCOL_REF: RfcRef = r(3848, '1', 'ESMTPS and ESMTPSA transmission types');
export const MDN_REF: RfcRef = HEADER_REFS['disposition-notification-to'] ?? r(8098, '2.1', 'Disposition-Notification-To');

// --- The toggle: a per-viewer convenience, kept in localStorage (never sent anywhere) ------------

export const LEARN_MODE_KEY_PREFIX = 'postroom:learn-mode:';

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLearnMode(accountId: string, store: KeyValueStore | null = storage()): boolean {
  try {
    return store?.getItem(LEARN_MODE_KEY_PREFIX + accountId) === '1';
  } catch {
    return false;
  }
}

export function writeLearnMode(accountId: string, on: boolean, store: KeyValueStore | null = storage()): void {
  try {
    store?.setItem(LEARN_MODE_KEY_PREFIX + accountId, on ? '1' : '0');
  } catch {
    // Private browsing or a full quota: learn mode just is not remembered. Nothing else depends on it.
    return;
  }
}
