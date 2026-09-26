// ENVELOPE and BODYSTRUCTURE from a scanned message (RFC 3501 §7.4.2, RFC 9051 §7.5.2), and the
// HEADER.FIELDS subset of a header block.
//
// Envelope strings are the raw header values (encoded-words intact), as RFC 3501 specifies. The one
// exception is a display name: @postroom/mime's address parser hands it back decoded, so for a
// session without UTF-8 it is re-encoded as RFC 2047 words, which means the same thing to a client.
import type { BodyParams, BodyStructure, Envelope, EnvelopeAddress, NString } from '@postroom/imap-proto';
import { encodeWords, parseAddressList, parseContentDisposition, type HeaderList, type Params } from '@postroom/mime';
import { transferEncoding, type MimeNode } from './structure.js';

function nonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) return true;
  return false;
}

function addressName(name: string, utf8: boolean): NString {
  if (name === '') return null;
  return !utf8 && nonAscii(name) ? encodeWords(name).join(' ') : name;
}

function splitAddress(address: string): { mailbox: string; host: string } {
  const at = address.lastIndexOf('@');
  if (at < 0) return { mailbox: address, host: '' };
  return { mailbox: address.slice(0, at), host: address.slice(at + 1) };
}

function addresses(value: string | null, utf8: boolean): EnvelopeAddress[] | null {
  if (value === null) return null;
  const out: EnvelopeAddress[] = [];
  for (const entry of parseAddressList(value)) {
    if ('group' in entry) {
      // RFC 3501: a group is (NIL NIL "name" NIL), its members, then (NIL NIL NIL NIL).
      out.push({ name: null, adl: null, mailbox: entry.group, host: null });
      for (const m of entry.members) {
        const { mailbox, host } = splitAddress(m.address);
        out.push({ name: addressName(m.name, utf8), adl: null, mailbox, host });
      }
      out.push({ name: null, adl: null, mailbox: null, host: null });
    } else {
      const { mailbox, host } = splitAddress(entry.address);
      out.push({ name: addressName(entry.name, utf8), adl: null, mailbox, host });
    }
  }
  return out.length === 0 ? null : out;
}

export function envelopeOf(headers: HeaderList, utf8: boolean): Envelope {
  const from = addresses(headers.get('from'), utf8);
  return {
    date: headers.get('date'),
    subject: headers.get('subject'),
    from,
    sender: addresses(headers.get('sender'), utf8) ?? from,
    replyTo: addresses(headers.get('reply-to'), utf8) ?? from,
    to: addresses(headers.get('to'), utf8),
    cc: addresses(headers.get('cc'), utf8),
    bcc: addresses(headers.get('bcc'), utf8),
    inReplyTo: headers.get('in-reply-to'),
    messageId: headers.get('message-id'),
  };
}

function paramList(params: Params): BodyParams {
  const entries = Object.entries(params).filter(([k]) => k.length > 0);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => [k.toUpperCase(), v] as const);
}

function extension(node: MimeNode): Pick<BodyStructure, 'disposition' | 'language' | 'location'> {
  const disp = parseContentDisposition(node.headers.get('content-disposition'));
  const lang = node.headers.get('content-language');
  const languages = lang === null ? null : lang.split(',').map((l) => l.trim()).filter((l) => l !== '');
  return {
    disposition: disp === null ? null : { type: disp.type.toUpperCase(), params: paramList(disp.params) },
    language: languages === null || languages.length === 0 ? null : languages,
    location: node.headers.get('content-location'),
  };
}

const EMPTY_TEXT: BodyStructure = {
  kind: 'single',
  type: 'TEXT',
  subtype: 'PLAIN',
  params: [['CHARSET', 'us-ascii']],
  id: null,
  description: null,
  encoding: '7BIT',
  size: 0,
  lines: 0,
};

/** The BODYSTRUCTURE tree of a node (`bodyStructureValue` decides BODY vs BODYSTRUCTURE). */
export function bodyStructureOf(node: MimeNode, utf8: boolean): BodyStructure {
  const ct = node.contentType;
  if (node.kind === 'multipart') {
    return {
      kind: 'multipart',
      subtype: ct.subtype.toUpperCase(),
      parts: node.children.length === 0 ? [EMPTY_TEXT] : node.children.map((c) => bodyStructureOf(c, utf8)),
      params: paramList(ct.params),
      ...extension(node),
    };
  }
  // A multipart we could not frame (no usable boundary) is served as plain text.
  const unframed = ct.type === 'multipart';
  const type = unframed ? 'TEXT' : ct.type.toUpperCase();
  const subtype = unframed ? 'PLAIN' : ct.subtype.toUpperCase();
  // RFC 2045 §5.2: a text part without a charset is us-ascii; say so, as other servers do.
  const given = node.hasContentType && !unframed ? ct.params : {};
  const params = paramList(type === 'TEXT' && given['charset'] === undefined ? { ...given, charset: 'us-ascii' } : given);
  const base = {
    kind: 'single' as const,
    type,
    subtype,
    params,
    id: node.headers.get('content-id'),
    description: node.headers.get('content-description'),
    encoding: transferEncoding(node).toUpperCase(),
    size: node.bodyEnd - node.bodyStart,
    md5: node.headers.get('content-md5'),
    ...extension(node),
  };
  if (node.kind === 'message' && node.message !== null) {
    return { ...base, lines: node.lines, envelope: envelopeOf(node.message.headers, utf8), body: bodyStructureOf(node.message, utf8) };
  }
  if (type === 'TEXT') return { ...base, lines: node.lines };
  return base;
}

/** HEADER.FIELDS / HEADER.FIELDS.NOT: the matching fields as received, then the blank line. */
export function headerFields(headers: HeaderList, fields: readonly string[], not: boolean): Buffer {
  const wanted = new Set(fields.map((f) => f.toLowerCase()));
  const out: Buffer[] = [];
  for (const f of headers.fields) {
    if (wanted.has(f.key) === not) continue;
    out.push(f.raw, Buffer.from('\r\n'));
  }
  out.push(Buffer.from('\r\n'));
  return Buffer.concat(out);
}
