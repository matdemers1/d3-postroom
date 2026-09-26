// LIST (RFC 9051 §6.3.9 with LIST-EXTENDED, RFC 5258) and LSUB (RFC 3501 §6.3.9), as a pure
// function of the account's mailboxes.
//
// Attributes: \HasChildren / \HasNoChildren always (CHILDREN is part of rev2); the special-use
// attribute (\Sent, \Drafts, \Trash, \Junk, \Archive) always, which is what clients that never ask
// for RETURN (SPECIAL-USE) still rely on; \Subscribed when the selection or RETURN asks for it. A
// name that only exists as the parent of others ("a" when only "a/b" does) is listed as \Noselect.
// RECURSIVEMATCH is accepted and adds CHILDINFO for parents of matching subscribed mailboxes.
import type { ListReturnOpt, ListSelectOpt, StatusAtt } from '@postroom/imap-proto';
import { DELIMITER, listPattern, parentsOf, specialUseAttribute } from './names.js';
import type { MailboxInfo } from './store.js';

export interface ListLine {
  readonly name: string;
  readonly attributes: string[];
  /** CHILDINFO ("SUBSCRIBED") for RECURSIVEMATCH. */
  readonly childInfo: boolean;
  /** The mailbox, when it exists (for LIST-STATUS). */
  readonly mailbox: MailboxInfo | null;
}

export interface ListRequest {
  readonly selection: readonly ListSelectOpt[] | null;
  readonly reference: string;
  readonly patterns: readonly string[];
  readonly returnOpts: readonly ListReturnOpt[] | null;
}

/** STATUS items LIST-STATUS asked for, or null. */
export function listStatusItems(req: ListRequest): readonly StatusAtt[] | null {
  for (const o of req.returnOpts ?? []) if (o.type === 'STATUS') return o.items;
  return null;
}

function order(a: string, b: string): number {
  if (a === 'INBOX') return b === 'INBOX' ? 0 : -1;
  if (b === 'INBOX') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function listMailboxes(all: readonly MailboxInfo[], req: ListRequest): ListLine[] {
  const selection = new Set(req.selection ?? []);
  const returns = new Set((req.returnOpts ?? []).map((o) => o.type));
  const wantSubscribed = selection.has('SUBSCRIBED') || returns.has('SUBSCRIBED');
  const regexes = req.patterns.map((p) => listPattern(req.reference, p));
  const matches = (name: string): boolean => regexes.some((r) => r.test(name));

  const byName = new Map(all.map((m) => [m.name, m]));
  const names = new Set<string>(byName.keys());
  for (const m of all) for (const p of parentsOf(m.name)) names.add(p);
  const hasChildren = new Set<string>();
  for (const n of names) for (const p of parentsOf(n)) hasChildren.add(p);

  const out: ListLine[] = [];
  for (const name of [...names].sort(order)) {
    const mb = byName.get(name) ?? null;
    const special = mb === null ? null : specialUseAttribute(mb.specialUse);
    const subscribed = mb?.subscribed === true;
    let childInfo = false;
    if (selection.has('SUBSCRIBED')) {
      if (!subscribed) {
        // RECURSIVEMATCH: a non-matching parent of a subscribed mailbox appears with CHILDINFO.
        if (!selection.has('RECURSIVEMATCH')) continue;
        const prefix = `${name}${DELIMITER}`;
        if (!all.some((m) => m.subscribed && m.name.startsWith(prefix))) continue;
        childInfo = true;
      }
    }
    if (selection.has('SPECIAL-USE') && special === null) continue;
    if (!matches(name)) continue;
    const attributes: string[] = [];
    if (mb === null) attributes.push('\\Noselect');
    attributes.push(hasChildren.has(name) ? '\\HasChildren' : '\\HasNoChildren');
    if (wantSubscribed && subscribed) attributes.push('\\Subscribed');
    if (special !== null) attributes.push(special);
    out.push({ name, attributes, childInfo, mailbox: mb });
  }
  return out;
}

/** LSUB: subscribed mailboxes matching the pattern (rev1). */
export function lsubMailboxes(all: readonly MailboxInfo[], reference: string, pattern: string): ListLine[] {
  const re = listPattern(reference, pattern);
  return all
    .filter((m) => m.subscribed && re.test(m.name))
    .sort((a, b) => order(a.name, b.name))
    .map((m) => {
      const special = specialUseAttribute(m.specialUse);
      return { name: m.name, attributes: special === null ? [] : [special], childInfo: false, mailbox: m };
    });
}
