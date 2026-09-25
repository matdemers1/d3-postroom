// SMTP replies (RFC 5321 §4.2) with enhanced status codes (RFC 3463, RFC 2034).
//
// A reply is data, not a string: daemons build `SmtpReply` objects and the writer formats them.
// The writer is the only place a reply becomes bytes, so it is the only place that has to make sure
// interpolated text (an address, a hostname, a reason from a hook) can never smuggle a CR or LF onto
// the wire and forge a second reply line.

export interface SmtpReply {
  /** Three-digit reply code, 200–599. */
  readonly code: number;
  /** Enhanced status code (`class.subject.detail`, e.g. `2.1.0`), when there is one. */
  readonly enhanced?: string;
  /** One entry per reply line; at least one. Text only — codes are added by the writer. */
  readonly lines: readonly string[];
}

const ENHANCED_RE = /^([245])\.(\d{1,3})\.(\d{1,3})$/;

/** Build a reply. `enhanced` may be `undefined` (greeting, 354, EHLO, 334). */
export function reply(code: number, enhanced: string | undefined, ...lines: string[]): SmtpReply {
  const body = lines.length === 0 ? [''] : lines;
  return enhanced === undefined ? { code, lines: body } : { code, enhanced, lines: body };
}

export function isValidReplyCode(code: number): boolean {
  return Number.isInteger(code) && code >= 200 && code <= 599;
}

export function isValidEnhancedCode(code: number, enhanced: string): boolean {
  const m = ENHANCED_RE.exec(enhanced);
  return m !== null && m[1] === String(Math.floor(code / 100));
}

/**
 * Make text safe for a reply line: every C0 control (CR and LF included) and DEL becomes a space.
 * UTF-8 text is kept — RFC 6531 permits it once SMTPUTF8 is in play, and it cannot break framing.
 */
export function sanitizeReplyText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, ' ');
}

export interface FormatReplyOptions {
  /** Prefix each line with the enhanced code (only after EHLO advertised ENHANCEDSTATUSCODES). */
  readonly enhanced?: boolean;
}

/**
 * Format a reply as wire text, CRLF-terminated, multiline as `250-…` … `250 …`.
 * Throws `TypeError` on an invalid code — that is a programming error, never peer input.
 */
export function formatReply(r: SmtpReply, options: FormatReplyOptions = {}): string {
  if (!isValidReplyCode(r.code)) throw new TypeError(`invalid SMTP reply code ${String(r.code)}`);
  const enhanced = options.enhanced === false ? undefined : r.enhanced;
  if (enhanced !== undefined && !isValidEnhancedCode(r.code, enhanced)) {
    throw new TypeError(`enhanced code ${enhanced} does not match reply code ${String(r.code)}`);
  }
  const lines = r.lines.length === 0 ? [''] : r.lines;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const last = i === lines.length - 1;
    let text = sanitizeReplyText(lines[i] ?? '');
    if (enhanced !== undefined) text = text === '' ? enhanced : `${enhanced} ${text}`;
    const sep = last ? ' ' : '-';
    out += text === '' ? `${String(r.code)}${last ? '' : '-'}\r\n` : `${String(r.code)}${sep}${text}\r\n`;
  }
  return out;
}

// --- EHLO -------------------------------------------------------------------------------------

/**
 * The EHLO reply: first line is `<hostname> <greeting>`, then one capability per line.
 * No enhanced code — RFC 2034 codes apply to replies after the extension is negotiated.
 */
export function buildEhloReply(hostname: string, greeting: string, capabilities: readonly string[]): SmtpReply {
  const first = greeting === '' ? hostname : `${hostname} ${greeting}`;
  return { code: 250, lines: [first, ...capabilities] };
}

/** Parse an EHLO reply (client side) into keyword (upper-case) → parameters. */
export function parseEhloCapabilities(r: SmtpReply): Map<string, string[]> {
  const caps = new Map<string, string[]>();
  for (const line of r.lines.slice(1)) {
    const parts = line.trim().split(/\s+/).filter((p) => p !== '');
    const keyword = parts[0];
    if (keyword === undefined) continue;
    caps.set(keyword.toUpperCase(), parts.slice(1));
  }
  return caps;
}

// --- Replies the protocol layer itself sends ----------------------------------------------------

export const Replies = {
  ok: reply(250, '2.0.0', 'OK'),
  mailOk: reply(250, '2.1.0', 'Sender OK'),
  rcptOk: reply(250, '2.1.5', 'Recipient OK'),
  reset: reply(250, '2.0.0', 'Reset'),
  bye: reply(221, '2.0.0', 'Bye'),
  vrfy: reply(252, '2.5.0', 'Cannot VRFY user, but will accept message and attempt delivery'),
  help: reply(214, '2.0.0', 'See RFC 5321'),
  startData: reply(354, undefined, 'End data with <CR><LF>.<CR><LF>'),
  startTls: reply(220, '2.0.0', 'Ready to start TLS'),
  authOk: reply(235, '2.7.0', 'Authentication successful'),

  bareLineEnding: reply(500, '5.5.2', 'Bare LF/CR not allowed'),
  lineTooLong: reply(500, '5.5.2', 'Line too long'),
  unknownCommand: reply(500, '5.5.1', 'Command not recognized'),
  notImplemented: reply(502, '5.5.1', 'Command not implemented'),
  ehloFirst: reply(503, '5.5.1', 'Send EHLO first'),
  mailFirst: reply(503, '5.5.1', 'Need MAIL command'),
  rcptFirst: reply(503, '5.5.1', 'Need RCPT command'),
  nestedMail: reply(503, '5.5.1', 'Sender already specified'),
  noValidRecipients: reply(554, '5.5.1', 'No valid recipients'),
  alreadyTls: reply(503, '5.5.1', 'TLS already active'),
  tlsUnavailable: reply(502, '5.5.1', 'STARTTLS not available'),
  alreadyAuthenticated: reply(503, '5.5.1', 'Already authenticated'),
  authInTransaction: reply(503, '5.5.1', 'AUTH not permitted during a mail transaction'),
  authUnavailable: reply(502, '5.5.1', 'AUTH not available'),
  authNeedsTls: reply(538, '5.7.11', 'Encryption required for requested authentication mechanism'),
  authMechanism: reply(504, '5.5.4', 'Unrecognized authentication type'),
  authCancelled: reply(501, '5.0.0', 'Authentication cancelled'),
  authLineInvalid: reply(501, '5.5.2', 'Cannot decode response'),
  authTempFail: reply(454, '4.7.0', 'Temporary authentication failure'),
  tooManyRecipients: reply(452, '4.5.3', 'Too many recipients'),
  messageTooBig: reply(552, '5.3.4', 'Message size exceeds fixed maximum message size'),
  bareLineEndingInData: reply(550, '5.6.0', 'Bare LF/CR not allowed in message data'),
  nulInData: reply(550, '5.6.0', 'NUL octets not allowed in message data'),
  localError: reply(451, '4.3.0', 'Local error in processing'),
  tooManyErrors: reply(421, '4.7.0', 'Too many errors, closing connection'),
  idleTimeout: reply(421, '4.4.2', 'Idle timeout, closing connection'),
  shuttingDown: reply(421, '4.3.2', 'Service shutting down'),
} as const satisfies Record<string, SmtpReply>;
