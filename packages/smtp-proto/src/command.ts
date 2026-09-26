// The SMTP command parser (RFC 5321 §4.1, with RFC 1870 SIZE, RFC 6152 8BITMIME, RFC 6531
// SMTPUTF8, RFC 3461 DSN, RFC 4954 AUTH, RFC 3207 STARTTLS).
//
// Input is one command line as bytes, without its CRLF (from `SmtpLineReader`). Output is a typed
// command or the reply to send. The parser never throws on any input.
//
// Tolerance, deliberately narrow: verbs are case-insensitive; runs of spaces between tokens and
// trailing spaces are accepted; `MAIL FROM: <a@b>` (space after the colon) is accepted, as every
// deployed MTA does. Everything else that is not the grammar is refused.

import {
  decodeXtext,
  encodeXtext,
  formatForwardPath,
  formatReversePath,
  isAddressLiteral,
  isDomain,
  parsePath,
  type ForwardPath,
  type ReversePath,
} from './address.js';
import { reply, type SmtpReply } from './reply.js';

export type BodyType = '7BIT' | '8BITMIME';
export type DsnRet = 'FULL' | 'HDRS';
export type DsnNotify = 'NEVER' | 'SUCCESS' | 'FAILURE' | 'DELAY';

export interface MailParams {
  readonly size?: number;
  readonly body?: BodyType;
  readonly smtputf8?: boolean;
  /** RFC 4954 §5 AUTH= (decoded xtext); `<>` when the submitter asserts no identity. */
  readonly auth?: string;
  readonly ret?: DsnRet;
  /** RFC 3461 ENVID (decoded xtext). */
  readonly envid?: string;
}

export interface RcptParams {
  readonly notify?: readonly DsnNotify[];
  /** RFC 3461 ORCPT as `addr-type;address` (address decoded from xtext). */
  readonly orcpt?: { readonly addrType: string; readonly address: string };
}

export type SmtpCommand =
  | { readonly verb: 'EHLO' | 'HELO'; readonly domain: string }
  | { readonly verb: 'MAIL'; readonly from: ReversePath; readonly params: MailParams }
  | { readonly verb: 'RCPT'; readonly to: ForwardPath; readonly params: RcptParams }
  | { readonly verb: 'DATA' | 'RSET' | 'QUIT' | 'STARTTLS' }
  | { readonly verb: 'NOOP' | 'HELP'; readonly argument?: string }
  | { readonly verb: 'VRFY'; readonly argument: string }
  | { readonly verb: 'AUTH'; readonly mechanism: string; readonly initialResponse?: string };

export type ParseResult =
  | { readonly ok: true; readonly command: SmtpCommand }
  | { readonly ok: false; readonly reply: SmtpReply };

export interface ParseCommandOptions {
  /** The open transaction declared SMTPUTF8, so RCPT may carry UTF-8 addresses. */
  readonly smtputf8?: boolean;
}

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

const unknownCommand = reply(500, '5.5.1', 'Command not recognized');
const invalidChars = reply(500, '5.5.2', 'Invalid characters in command');
const notImplemented = reply(502, '5.5.1', 'Command not implemented');

function syntax(text: string): ParseResult {
  return { ok: false, reply: reply(501, '5.5.4', text) };
}
function fail(code: number, enhanced: string, text: string): ParseResult {
  return { ok: false, reply: reply(code, enhanced, text) };
}
function ok(command: SmtpCommand): ParseResult {
  return { ok: true, command };
}

const NO_ARG_VERBS = new Set(['DATA', 'RSET', 'QUIT', 'STARTTLS']);
const UNIMPLEMENTED = new Set(['EXPN', 'TURN', 'ETRN', 'ATRN', 'BDAT', 'SEND', 'SOML', 'SAML']);

export function parseCommand(line: Uint8Array, options: ParseCommandOptions = {}): ParseResult {
  let ascii = true;
  for (const b of line) {
    if (b < 0x20 || b === 0x7f) return { ok: false, reply: invalidChars };
    if (b >= 0x80) ascii = false;
  }
  let text: string;
  if (ascii) text = Buffer.from(line.buffer, line.byteOffset, line.length).toString('latin1');
  else {
    try {
      text = fatalUtf8.decode(line);
    } catch (err) {
      if (err instanceof TypeError) return { ok: false, reply: invalidChars };
      throw err;
    }
  }
  const sp = text.indexOf(' ');
  const verb = (sp < 0 ? text : text.slice(0, sp)).toUpperCase();
  const args = sp < 0 ? '' : text.slice(sp + 1).replace(/^ +/, '').replace(/ +$/, '');
  if (!/^[A-Z]{4,8}$/.test(verb)) return { ok: false, reply: unknownCommand };
  if (!ascii && verb !== 'MAIL' && verb !== 'RCPT') return { ok: false, reply: invalidChars };

  if (NO_ARG_VERBS.has(verb)) {
    if (args !== '') return syntax(`${verb} takes no arguments`);
    return ok({ verb: verb as 'DATA' | 'RSET' | 'QUIT' | 'STARTTLS' });
  }
  switch (verb) {
    case 'EHLO':
    case 'HELO':
      return parseHello(verb, args);
    case 'MAIL':
      return parseMail(args);
    case 'RCPT':
      return parseRcpt(args, options.smtputf8 === true);
    case 'NOOP':
    case 'HELP':
      return ok(args === '' ? { verb } : { verb, argument: args });
    case 'VRFY':
      if (args === '') return syntax('VRFY requires an argument');
      return ok({ verb, argument: args });
    case 'AUTH':
      return parseAuth(args);
    default:
      return { ok: false, reply: UNIMPLEMENTED.has(verb) ? notImplemented : unknownCommand };
  }
}

function parseHello(verb: 'EHLO' | 'HELO', args: string): ParseResult {
  if (args === '') return syntax(`${verb} requires a domain or address literal`);
  if (args.includes(' ')) return syntax(`${verb} takes exactly one argument`);
  const valid = args.startsWith('[') ? isAddressLiteral(args) : isDomain(args);
  if (!valid) return syntax('Invalid domain or address literal');
  return ok({ verb, domain: args });
}

interface RawParam {
  readonly keyword: string;
  readonly value: string | undefined;
}

/** Split `SP param *(SP param)` into keyword/value pairs; null on syntax error. */
function splitParams(rest: string): RawParam[] | { error: ParseResult } {
  if (rest === '') return [];
  if (!rest.startsWith(' ')) return { error: syntax('Expected a space before parameters') };
  const out: RawParam[] = [];
  const seen = new Set<string>();
  for (const token of rest.trim().split(/ +/)) {
    const eq = token.indexOf('=');
    const keyword = (eq < 0 ? token : token.slice(0, eq)).toUpperCase();
    const value = eq < 0 ? undefined : token.slice(eq + 1);
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(keyword)) return { error: syntax('Invalid parameter keyword') };
    // esmtp-value = 1*(%d33-60 / %d62-126 / UTF8-non-ascii)
    if (value !== undefined && !/^[\x21-\x3c\x3e-\x7e\u0080-\u{10ffff}]+$/u.test(value)) {
      return { error: syntax('Invalid parameter value') };
    }
    if (seen.has(keyword)) return { error: syntax(`Duplicate ${keyword} parameter`) };
    seen.add(keyword);
    out.push({ keyword, value });
  }
  return out;
}

/** Parse the `FROM:` / `TO:` prefix and the path after it. */
function pathArgs(args: string, prefix: string, kind: 'reverse' | 'forward') {
  if (args.slice(0, prefix.length).toUpperCase() !== prefix) return null;
  let i = prefix.length;
  while (args[i] === ' ') i++;
  const parsed = parsePath(args, i, kind);
  return { parsed, rest: parsed.ok ? args.slice(parsed.end) : '' };
}

function parseMail(args: string): ParseResult {
  const p = pathArgs(args, 'FROM:', 'reverse');
  if (p === null) return syntax('Syntax: MAIL FROM:<address>');
  if (!p.parsed.ok) return fail(501, '5.1.7', `Bad sender address syntax: ${p.parsed.reason}`);
  const raw = splitParams(p.rest);
  if (!Array.isArray(raw)) return raw.error;
  const params: {
    size?: number;
    body?: BodyType;
    smtputf8?: boolean;
    auth?: string;
    ret?: DsnRet;
    envid?: string;
  } = {};
  for (const { keyword, value } of raw) {
    switch (keyword) {
      case 'SIZE':
        if (value === undefined || !/^\d{1,20}$/.test(value)) return syntax('Invalid SIZE');
        params.size = Number(value);
        break;
      case 'BODY': {
        const v = value?.toUpperCase();
        if (v !== '7BIT' && v !== '8BITMIME') return syntax('Invalid BODY (7BIT or 8BITMIME)');
        params.body = v;
        break;
      }
      case 'SMTPUTF8':
        if (value !== undefined) return syntax('SMTPUTF8 takes no value');
        params.smtputf8 = true;
        break;
      case 'AUTH': {
        const decoded = value === undefined ? null : decodeXtext(value);
        if (decoded === null || decoded === '' || hasControl(decoded)) return syntax('Invalid AUTH parameter');
        params.auth = decoded;
        break;
      }
      case 'RET': {
        const v = value?.toUpperCase();
        if (v !== 'FULL' && v !== 'HDRS') return syntax('Invalid RET (FULL or HDRS)');
        params.ret = v;
        break;
      }
      case 'ENVID': {
        const decoded = value === undefined ? null : decodeXtext(value);
        if (decoded === null || decoded === '' || decoded.length > 100 || hasControl(decoded)) return syntax('Invalid ENVID');
        params.envid = decoded;
        break;
      }
      default:
        return fail(555, '5.5.4', `Unsupported parameter ${keyword}`);
    }
  }
  if (p.parsed.nonAscii && params.smtputf8 !== true) {
    return fail(553, '5.6.7', 'Non-ASCII address requires SMTPUTF8');
  }
  return ok({ verb: 'MAIL', from: p.parsed.path as ReversePath, params });
}

const NOTIFY_VALUES = new Set(['SUCCESS', 'FAILURE', 'DELAY']);

/**
 * True when a decoded xtext value holds a control character (PST-T-4.1, header injection). xtext
 * can smuggle CR, LF or NUL as "+0D+0A" into ENVID, ORCPT or AUTH=, and those values are echoed
 * into headers later (a DSN's Original-Envelope-Id, Original-Recipient). RFC 3461 §4 and RFC 4954
 * §5 only ever mean printable US-ASCII there, so a control character is a syntax error on the wire.
 */
function hasControl(s: string): boolean {
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  return /[\u0000-\u001f\u007f]/.test(s);
}

function parseRcpt(args: string, smtputf8: boolean): ParseResult {
  const p = pathArgs(args, 'TO:', 'forward');
  if (p === null) return syntax('Syntax: RCPT TO:<address>');
  if (!p.parsed.ok) return fail(501, '5.1.3', `Bad recipient address syntax: ${p.parsed.reason}`);
  if (p.parsed.nonAscii && !smtputf8) return fail(553, '5.6.7', 'Non-ASCII address requires SMTPUTF8');
  const raw = splitParams(p.rest);
  if (!Array.isArray(raw)) return raw.error;
  const params: { notify?: DsnNotify[]; orcpt?: { addrType: string; address: string } } = {};
  for (const { keyword, value } of raw) {
    switch (keyword) {
      case 'NOTIFY': {
        const list = (value ?? '').toUpperCase().split(',');
        const unique = new Set(list);
        const valid =
          value !== undefined &&
          unique.size === list.length &&
          (list.length === 1 && list[0] === 'NEVER' ? true : list.every((v) => NOTIFY_VALUES.has(v)));
        if (!valid) return syntax('Invalid NOTIFY');
        params.notify = list as DsnNotify[];
        break;
      }
      case 'ORCPT': {
        const semi = value?.indexOf(';') ?? -1;
        if (value === undefined || semi <= 0) return syntax('Invalid ORCPT');
        const addrType = value.slice(0, semi);
        const address = decodeXtext(value.slice(semi + 1));
        if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(addrType) || address === null || address === '' || hasControl(address)) {
          return syntax('Invalid ORCPT');
        }
        params.orcpt = { addrType, address };
        break;
      }
      default:
        return fail(555, '5.5.4', `Unsupported parameter ${keyword}`);
    }
  }
  return ok({ verb: 'RCPT', to: p.parsed.path as ForwardPath, params });
}

function parseAuth(args: string): ParseResult {
  const parts = args === '' ? [] : args.split(/ +/);
  const mechanism = parts[0]?.toUpperCase();
  if (mechanism === undefined || parts.length > 2 || !/^[A-Z0-9_-]{1,20}$/.test(mechanism)) {
    return syntax('Syntax: AUTH mechanism [initial-response]');
  }
  const ir = parts[1];
  if (ir === undefined) return ok({ verb: 'AUTH', mechanism });
  if (ir !== '=' && !isBase64(ir)) return fail(501, '5.5.2', 'Invalid base64 in initial response');
  return ok({ verb: 'AUTH', mechanism, initialResponse: ir });
}

export function isBase64(s: string): boolean {
  return s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

// --- Formatting (client side, and the round-trip half of the parser's tests) --------------------

export function formatMailParams(p: MailParams): string {
  const out: string[] = [];
  if (p.size !== undefined) out.push(`SIZE=${String(p.size)}`);
  if (p.body !== undefined) out.push(`BODY=${p.body}`);
  if (p.smtputf8 === true) out.push('SMTPUTF8');
  if (p.auth !== undefined) out.push(`AUTH=${encodeXtext(p.auth)}`);
  if (p.ret !== undefined) out.push(`RET=${p.ret}`);
  if (p.envid !== undefined) out.push(`ENVID=${encodeXtext(p.envid)}`);
  return out.map((s) => ` ${s}`).join('');
}

export function formatRcptParams(p: RcptParams): string {
  const out: string[] = [];
  if (p.notify !== undefined) out.push(`NOTIFY=${p.notify.join(',')}`);
  if (p.orcpt !== undefined) out.push(`ORCPT=${p.orcpt.addrType};${encodeXtext(p.orcpt.address)}`);
  return out.map((s) => ` ${s}`).join('');
}

/** Format a command as a line without CRLF (append `\r\n` when writing). */
export function formatCommand(c: SmtpCommand): string {
  switch (c.verb) {
    case 'EHLO':
    case 'HELO':
      return `${c.verb} ${c.domain}`;
    case 'MAIL':
      return `MAIL FROM:${formatReversePath(c.from)}${formatMailParams(c.params)}`;
    case 'RCPT':
      return `RCPT TO:${formatForwardPath(c.to)}${formatRcptParams(c.params)}`;
    case 'DATA':
    case 'RSET':
    case 'QUIT':
    case 'STARTTLS':
      return c.verb;
    case 'NOOP':
    case 'HELP':
      return c.argument === undefined ? c.verb : `${c.verb} ${c.argument}`;
    case 'VRFY':
      return `VRFY ${c.argument}`;
    case 'AUTH':
      return c.initialResponse === undefined ? `AUTH ${c.mechanism}` : `AUTH ${c.mechanism} ${c.initialResponse}`;
  }
}
