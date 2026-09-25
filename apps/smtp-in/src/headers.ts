// The trace headers smtp-in prepends (PST-REQ-069): Received (RFC 5321 §4.4) and
// Authentication-Results (RFC 8601). data.ts prepends them to the stored message.
//
// Every value that came from the peer (the HELO name, a reverse-DNS name, an address) is stripped
// of control characters before it is written, so no CR/LF can end the field early and forge a
// header of its own. Fields are folded at 78 columns on whitespace.
import type { DkimResult, EvaluateSpfResult } from '@postroom/auth-checks';
import { authResultsDkim } from '@postroom/auth-checks';

export const FOLD_WIDTH = 78;

/** Remove C0 controls (CR, LF, NUL…) and DEL; collapse whitespace runs to one space. */
export function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Text safe inside a comment: parentheses and backslashes cannot unbalance it. */
export function commentText(text: string): string {
  return stripControls(text).replace(/[()\\]/g, '_');
}

/** A single token (no spaces, no comment or specials delimiters). */
function tokenText(text: string): string {
  const t = stripControls(text).replace(/[\s()\\;<>"]/g, '_');
  return t === '' ? 'unknown' : t;
}

/**
 * `Name: value` folded to `width` columns on spaces, CRLF-terminated. A single token longer than the
 * width is left whole (a fold is only permitted at whitespace); the line limit that matters for
 * correctness is 998, which no field built here approaches.
 */
export function foldHeader(name: string, value: string, width = FOLD_WIDTH): string {
  const words = stripControls(value).split(' ').filter((w) => w !== '');
  const lines: string[] = [];
  let line = `${name}:`;
  let lineHasWord = false;
  for (const word of words) {
    if (lineHasWord && line.length + 1 + word.length > width) {
      lines.push(line);
      line = `\t${word}`;
    } else {
      line = `${line} ${word}`;
    }
    lineHasWord = true;
  }
  lines.push(line);
  return `${lines.join('\r\n')}\r\n`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** RFC 5322 §3.3 date-time in UTC: `Fri, 25 Sep 2026 12:00:00 +0000`. */
export function formatRfc5322Date(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  const day = DAYS[d.getUTCDay()] ?? 'Sun';
  const month = MONTHS[d.getUTCMonth()] ?? 'Jan';
  return `${day}, ${String(d.getUTCDate())} ${month} ${String(d.getUTCFullYear())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
}

export type ReceivedProtocol = 'SMTP' | 'ESMTP' | 'ESMTPS' | 'UTF8SMTP' | 'UTF8SMTPS';

/** The `with` keyword (RFC 3848, RFC 6531 §3.7.3). */
export function receivedProtocol(opts: { ehlo: boolean; secure: boolean; smtputf8: boolean }): ReceivedProtocol {
  if (!opts.ehlo) return 'SMTP';
  if (opts.smtputf8) return opts.secure ? 'UTF8SMTPS' : 'UTF8SMTP';
  return opts.secure ? 'ESMTPS' : 'ESMTP';
}

export interface ReceivedInput {
  /** The EHLO/HELO argument as the client sent it. */
  readonly helo: string | null;
  /** Reverse DNS of the client, forward-confirmed; null when there is none. */
  readonly rdns: string | null;
  /** The real client IP (from PROXY v2 when the connection came through the edge). */
  readonly ip: string;
  /** Our name: `by <hostname>`. */
  readonly hostname: string;
  readonly protocol: ReceivedProtocol;
  /** The transaction id. */
  readonly id: string;
  /** Written as `for <…>` only when the message has exactly one recipient. */
  readonly recipients: readonly string[];
  readonly date: Date;
}

/**
 * `Received: from <helo> (<rdns or unknown> [<ip>]) by <hostname> (Postroom) with ESMTP[S] id <id>
 * for <rcpt>; <date>`
 */
export function buildReceived(input: ReceivedInput): string {
  const helo = input.helo === null ? 'unknown' : tokenText(input.helo);
  const rdns = input.rdns === null ? 'unknown' : commentText(input.rdns);
  const ip = commentText(input.ip).replace(/[[\]\s]/g, '');
  const parts = [
    `from ${helo} (${rdns} [${ip}])`,
    `by ${tokenText(input.hostname)} (Postroom)`,
    `with ${input.protocol}`,
    `id ${tokenText(input.id)}`,
  ];
  const only = input.recipients.length === 1 ? input.recipients[0] : undefined;
  if (only !== undefined) parts.push(`for <${stripControls(only).replace(/[<>]/g, '')}>`);
  return foldHeader('Received', `${parts.join(' ')}; ${formatRfc5322Date(input.date)}`);
}

const TSPECIALS = /[()<>@,;:\\"/[\]?=\s]/;

function pvalue(v: string): string {
  const clean = stripControls(v);
  if (clean !== '' && !TSPECIALS.test(clean)) return clean;
  return `"${clean.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The SPF method result, with the reason in a comment:
 * `spf=pass (sender IP 192.0.2.1; matched +ip4:192.0.2.0/24) smtp.mailfrom=example.com`.
 * Same method and property as `authResultsSpf`, plus the reason (auth decisions store their reasons).
 */
export function spfMethod(spf: EvaluateSpfResult, clientIp: string): string {
  const identity = spf.scope === 'helo' ? 'smtp.helo' : 'smtp.mailfrom';
  const why = [`sender IP ${clientIp}`];
  if (spf.mechanism !== undefined) why.push(`matched ${spf.mechanism}`);
  const last = spf.trace[spf.trace.length - 1];
  if (spf.result !== 'pass' && spf.mechanism === undefined && last !== undefined) why.push(last);
  return `spf=${spf.result} (${commentText(why.join('; '))}) ${identity}=${pvalue(spf.domain)}`;
}

export interface AuthenticationResultsInput {
  /** authserv-id: our hostname. */
  readonly hostname: string;
  readonly clientIp: string;
  readonly spf: EvaluateSpfResult | null;
  /** DKIM results from the streaming verifier; null when it did not run. */
  readonly dkim: readonly DkimResult[] | null;
  /** Further method results (dmarc=…, arc=…) from PST-T-2.5 / PST-T-2.6. */
  readonly extra?: readonly string[];
}

/** `Authentication-Results: mx.d3cloud.io; spf=… smtp.mailfrom=…; dkim=… header.d=…` */
export function buildAuthenticationResults(input: AuthenticationResultsInput): string {
  const methods: string[] = [];
  methods.push(input.spf === null ? 'spf=none' : spfMethod(input.spf, input.clientIp));
  methods.push(...(input.dkim === null ? ['dkim=none'] : authResultsDkim(input.dkim)));
  if (input.extra) methods.push(...input.extra);
  return foldHeader('Authentication-Results', `${tokenText(input.hostname)}; ${methods.map(stripControls).join('; ')}`);
}
