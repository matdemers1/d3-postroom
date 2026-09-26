// RFC 5322 §3.4 address lists: mailboxes, name-addr with display names (RFC 2047 encoded-words
// decoded), groups, quoted local parts, comments, domain literals, obsolete routes, and RFC 6532
// UTF-8. Lenient by design: never throws, and returns whatever mailboxes it can recover.

import { decodeEncodedWords } from './encoded-word.js';

export interface Mailbox {
  /** Display name, decoded; empty string when there is none. */
  readonly name: string;
  /** `local@domain` (local part re-quoted only if it must be); may lack `@` in broken mail. */
  readonly address: string;
}

export interface Group {
  readonly group: string;
  readonly members: readonly Mailbox[];
}

export type AddressEntry = Mailbox | Group;

type TokenKind = 'atom' | 'quoted' | 'comment' | 'literal' | 'special';

interface Token {
  kind: TokenKind;
  value: string;
  /** Whitespace preceded this token. */
  space: boolean;
}

const SPECIALS = new Set(['<', '>', '@', ',', ';', ':', '.', '[', ']', '(', ')', '"', '\\']);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let space = false;
  const n = input.length;
  while (i < n) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      space = true;
      i++;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < n) i++;
        value += input[i++] as string;
      }
      i++;
      tokens.push({ kind: 'quoted', value, space });
    } else if (ch === '(') {
      let depth = 1;
      let value = '';
      i++;
      while (i < n && depth > 0) {
        const c = input[i] as string;
        if (c === '\\' && i + 1 < n) {
          value += input[i + 1] as string;
          i += 2;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        if (depth > 0) value += c;
        i++;
      }
      tokens.push({ kind: 'comment', value: value.trim(), space });
    } else if (ch === '[') {
      let value = '[';
      i++;
      while (i < n && input[i] !== ']') {
        if (input[i] === '\\' && i + 1 < n) i++;
        value += input[i++] as string;
      }
      i++;
      tokens.push({ kind: 'literal', value: value + ']', space });
    } else if (SPECIALS.has(ch)) {
      tokens.push({ kind: 'special', value: ch, space });
      i++;
    } else {
      let value = '';
      while (i < n) {
        const c = input[i] as string;
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || SPECIALS.has(c)) break;
        value += c;
        i++;
      }
      tokens.push({ kind: 'atom', value, space });
    }
    space = false;
  }
  return tokens;
}

const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-\uffff]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-\uffff]+)*$/;

/** Build `local@domain` from addr-spec tokens (comments and whitespace dropped). */
function addrSpec(tokens: Token[]): string {
  // Obsolete route (RFC 5322 §4.4): `@a,@b:user@c` — drop everything up to the colon.
  let start = 0;
  if (tokens[0]?.kind === 'special' && tokens[0].value === '@') {
    const colon = tokens.findIndex((t) => t.kind === 'special' && t.value === ':');
    if (colon >= 0) start = colon + 1;
  }
  const parts = tokens.slice(start).filter((t) => t.kind !== 'comment');
  const at = parts.map((t) => t.kind === 'special' && t.value === '@').lastIndexOf(true);
  const render = (list: Token[], local: boolean): string =>
    list
      .map((t) => {
        if (t.kind !== 'quoted') return t.value;
        if (local && list.length === 1 && DOT_ATOM.test(t.value)) return t.value;
        return `"${t.value.replace(/(["\\])/g, '\\$1')}"`;
      })
      .join('');
  if (at < 0) return render(parts, true);
  return `${render(parts.slice(0, at), true)}@${render(parts.slice(at + 1), false)}`;
}

/** Display-name phrase: words joined by single spaces, encoded-words decoded. */
function phrase(tokens: Token[]): string {
  let out = '';
  let prevEncoded = false;
  for (const t of tokens) {
    if (t.kind === 'comment') continue;
    const isEncoded = t.kind === 'atom' && /^=\?[^?]+\?[BbQq]\?[^?]*\?=$/.test(t.value);
    const text = t.kind === 'atom' || t.kind === 'quoted' ? decodeEncodedWords(t.value) : t.value;
    // Whitespace between two encoded-words is not displayed (RFC 2047 §6.2); elsewhere it is one space.
    if (out !== '' && t.space && !(isEncoded && prevEncoded)) out += ' ';
    out += text;
    prevEncoded = isEncoded;
  }
  return out.trim();
}

function toMailbox(tokens: Token[]): Mailbox | null {
  const meaningful = tokens.filter((t) => t.kind !== 'comment');
  if (meaningful.length === 0) return null;
  const lt = tokens.findIndex((t) => t.kind === 'special' && t.value === '<');
  if (lt >= 0) {
    let gt = tokens.findIndex((t, idx) => idx > lt && t.kind === 'special' && t.value === '>');
    if (gt < 0) gt = tokens.length;
    const name = phrase(tokens.slice(0, lt));
    return { name, address: addrSpec(tokens.slice(lt + 1, gt)) };
  }
  // A bare addr-spec; a trailing comment is the old-style display name: `a@b (Jane Doe)`.
  const comment = tokens.find((t) => t.kind === 'comment' && t.value !== '');
  return { name: comment === undefined ? '' : decodeEncodedWords(comment.value), address: addrSpec(tokens) };
}

/** Parse an address-list or mailbox-list header value. */
export function parseAddressList(value: string): AddressEntry[] {
  const tokens = tokenize(value);
  const out: AddressEntry[] = [];
  let current: Token[] = [];
  let group: { name: string; members: Mailbox[] } | null = null;
  let inAngle = false;
  const flush = (): void => {
    const mb = toMailbox(current);
    current = [];
    if (mb === null) return;
    if (group !== null) group.members.push(mb);
    else out.push(mb);
  };
  for (const t of tokens) {
    if (t.kind === 'special') {
      if (t.value === '<') inAngle = true;
      else if (t.value === '>') inAngle = false;
      else if (!inAngle && t.value === ',') {
        flush();
        continue;
      } else if (!inAngle && t.value === ':' && group === null && !current.some((c) => c.kind === 'special' && c.value === '@')) {
        group = { name: phrase(current), members: [] };
        current = [];
        continue;
      } else if (!inAngle && t.value === ';' && group !== null) {
        flush();
        out.push({ group: group.name, members: group.members });
        group = null;
        continue;
      }
    }
    current.push(t);
  }
  flush();
  if (group !== null) out.push({ group: group.name, members: group.members });
  return out;
}

/** Every mailbox in the list, with groups flattened. */
export function parseMailboxes(value: string): Mailbox[] {
  const out: Mailbox[] = [];
  for (const entry of parseAddressList(value)) {
    if ('group' in entry) out.push(...entry.members);
    else out.push(entry);
  }
  return out;
}
