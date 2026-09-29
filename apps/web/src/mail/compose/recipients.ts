// The glue between the composer's address strings and RecipientField's chips (PST-T-14.7,
// PST-REQ-191; design audit TF-07). The composer keeps To/Cc/Bcc as the comma-separated header
// strings compose.ts, drafts and the key checks already speak; the field shows them as chips. These
// helpers turn one into the other without losing a display name — including a quoted one with a
// comma in it — and suggest contacts for what has been typed. Pure, so they are unit-tested; they
// import only types from @d3cloud/ui, never its runtime.
import type { Recipient, RecipientSuggestion } from '@d3cloud/ui';
import type { Alias, ContactSummary } from '../../api';
import { splitAddresses } from '../format';

/** One header entry — `a@b`, `Name <a@b>`, `"Last, First" <a@b>` — as a chip. The address keeps its case. */
export function recipientOf(entry: string): Recipient | null {
  const text = entry.trim();
  if (text === '') return null;
  const angle = /^(.*?)<([^<>]*)>\s*$/.exec(text);
  if (angle === null) return { address: text.replace(/^"|"$/g, '') };
  const address = (angle[2] ?? '').trim();
  const name = (angle[1] ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim();
  if (address === '') return name === '' ? null : { address: name };
  return name === '' || name.toLowerCase() === address.toLowerCase() ? { address } : { name, address };
}

/** A header string as chips. */
export function toRecipients(text: string): Recipient[] {
  return splitAddresses(text)
    .map(recipientOf)
    .filter((r): r is Recipient => r !== null);
}

/** Quote a display name when it holds anything RFC 5322 would read as structure. */
function quoteName(name: string): string {
  return /[(),.:;<>@[\\\]"]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name;
}

/** A chip as a header entry. */
export function entryOf(r: Recipient): string {
  const name = r.name?.trim() ?? '';
  return name === '' ? r.address : `${quoteName(name)} <${r.address}>`;
}

/** Chips as a header string — what compose.ts splits again on send. */
export function fromRecipients(list: readonly Recipient[]): string {
  return list.map(entryOf).join(', ');
}

/** How many suggestions the list offers at once. */
export const SUGGESTION_LIMIT = 8;

/**
 * Suggestions from the address book for what has been typed: every address of every contact whose
 * name or address matches, name first. The contacts API already filters by `q`; this narrows again
 * so a contact with several addresses offers only the ones that match when the query is an address.
 */
export function contactSuggestions(contacts: readonly ContactSummary[], query: string): RecipientSuggestion[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const out: RecipientSuggestion[] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    const name = c.displayName.trim();
    const nameMatches = name.toLowerCase().includes(q) || c.org.toLowerCase().includes(q);
    for (const address of c.emails) {
      const key = address.toLowerCase();
      if (seen.has(key) || (!nameMatches && !key.includes(q))) continue;
      seen.add(key);
      out.push(name === '' ? { address, detail: 'Contact' } : { name, address, detail: 'Contact' });
      if (out.length >= SUGGESTION_LIMIT) return out;
    }
  }
  return out;
}

/** The addresses the From row offers: the account's own first, then its live masked aliases. */
export function fromChoices(me: string | null, aliases: readonly Pick<Alias, 'address' | 'killedAt'>[]): string[] {
  const out: string[] = me === null ? [] : [me];
  for (const a of aliases) if (a.killedAt === null && !out.includes(a.address)) out.push(a.address);
  return out;
}

/** The From row exists only when there is a choice to make (PST-T-14.7): an alias beside the primary. */
export function hasFromChoice(choices: readonly string[]): boolean {
  return choices.length > 1;
}
