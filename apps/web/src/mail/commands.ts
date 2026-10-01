// The command palette's registry (PST-T-9.3, PST-REQ-147): every keyboard action from keys.ts (so
// the palette can never list one that does nothing, the same guarantee ShortcutsOverlay makes), a
// "Move to <bucket>" command per mailbox for the message under the cursor, "Go to <mailbox>" for
// every mailbox, and — since PST-T-14.3 — every place in the route table (routes.ts), grouped as
// Actions, Go to, Settings and Admin, with keycaps from keys.ts where a binding exists. PST-T-15.5
// renamed "Message actions" to "Actions" (the redesign's group) and leads it, with a message in hand,
// with the three things the palette is opened for: Archive, Snooze and Move.
// Pure and DOM-free, so the registry and the fuzzy matcher are unit-tested without a browser.
import type { Mailbox, MessageSummary } from '../api';
import { snoozeChoices } from './compose';
import { mailboxLabel } from './format';
import { requestInspect, SHORTCUTS, type MailAction } from './keys';
import { mailboxKey, mailPath } from './route';
import { paletteRoutes } from '../routes';
import { COARSE_POINTER_QUERY } from '../mobile/swipe';

/** The palette's groups, in the order it shows them (PST-T-14.3). */
export const COMMAND_GROUPS = ['Actions', 'Go to', 'Settings', 'Admin'] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** Extra text a query can match against, beyond the label (a shortcut key, a synonym). */
  keywords: string;
  /** The keys that do this without the palette, split into keycaps ('g', 'then', 'i'); from keys.ts only. */
  keycaps?: string[];
  /** A one-line hint beside the label. */
  hint?: string;
  /** The mailbox a "Go to <mailbox>" command opens — the palette draws its icon. */
  mailbox?: Mailbox;
  run: () => void;
}

export interface CommandContext {
  mailboxes: readonly Mailbox[] | null;
  /** The message the cursor or the reading pane is on, if any — what "Move to X" acts on. */
  target: MessageSummary | null;
  /** Absent outside Mail (Settings, the Admin console): no keyboard-action commands there. */
  perform?: (action: MailAction) => void;
  move: (message: MessageSummary, mailbox: Mailbox) => void;
  navigate: (path: string) => void;
  /** PST-T-9.1: snooze the target's conversation until a time (absent: no snooze commands). */
  snooze?: (message: MessageSummary, until: Date) => void;
  /** The clock snooze choices are relative to (tests pin it). */
  now?: () => Date;
}

/** 'g then i' → ['g', 'then', 'i']; 'Shift + u' → ['Shift', 'u']; 'o or Enter' → ['o', 'or', 'Enter']. */
export function keycapsFor(keys: string): string[] {
  return keys
    .split(/\s*\+\s*|\s+/)
    .filter((k) => k !== '');
}

function shortcutKeys(action: MailAction): string[] | undefined {
  const s = SHORTCUTS.find((x) => x.action === action);
  return s === undefined ? undefined : keycapsFor(s.keys);
}

/** Keycaps as the library's CommandPalette draws them (one key cap per entry): the first of several
 * alternatives ('o or Enter' → o), and a sequence without its connective ('g then i' → g, i). */
export function paletteShortcut(keycaps: readonly string[]): string[] {
  const orAt = keycaps.indexOf('or');
  const first = orAt < 0 ? keycaps : keycaps.slice(0, orAt);
  return first.filter((k) => k !== 'then');
}

/** With a message in hand, the Actions group leads with these, in this order (PST-T-15.5). */
export const LEAD_ACTIONS: readonly MailAction[] = ['archive', 'snooze', 'moveTo'];

const PLACE_GROUP: Readonly<Record<'mail' | 'settings' | 'admin', CommandGroup>> = { mail: 'Go to', settings: 'Settings', admin: 'Admin' };

/** Keyboard-only navigation: j/k move a cursor, o/Enter open, u goes back. Meaningless on a touch
 * screen, where a tap opens a row and the back button goes back (PST-T-16.15, PST-DA-035). */
/** Acts on the message in hand; with none open (PST-T-17.5, PST-DA-086) they would do nothing, so the
 * palette leaves them out. Next and Previous move within the open message's list. */
export const NEEDS_MESSAGE_ACTIONS: readonly MailAction[] = ['archive', 'snooze', 'moveTo', 'next', 'prev'];

export const KEYBOARD_ONLY_ACTIONS: readonly MailAction[] = ['next', 'prev', 'open', 'back'];

/** Whether the primary pointer is a finger. With no matchMedia (tests, SSR) it is not. */
export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/**
 * Builds the full command list for the current context, in COMMAND_GROUPS order. With `coarse` (a
 * touch screen; read from the device when omitted) the keyboard-only navigation commands are left out.
 */
export function buildCommands(ctx: CommandContext, isAdmin = false, coarse: boolean = isCoarsePointer()): Command[] {
  const commands: Command[] = [];
  const perform = ctx.perform;

  if (perform !== undefined) {
    const lead = (a: MailAction): number => (ctx.target === null ? -1 : LEAD_ACTIONS.indexOf(a));
    const shortcuts = [...SHORTCUTS].sort((a, b) => {
      const la = lead(a.action);
      const lb = lead(b.action);
      return (la < 0 ? LEAD_ACTIONS.length : la) - (lb < 0 ? LEAD_ACTIONS.length : lb);
    });
    for (const s of shortcuts) {
      // The palette opens itself; a command that opens the thing it is already inside of is noise.
      // Go to Inbox is listed with the mailboxes below, carrying g then i as its keycaps.
      if (s.action === 'commandPalette' || (s.action === 'goInbox' && ctx.mailboxes !== null)) continue;
      if (coarse && KEYBOARD_ONLY_ACTIONS.includes(s.action)) continue;
      if (ctx.target === null && NEEDS_MESSAGE_ACTIONS.includes(s.action)) continue;
      commands.push({
        id: `action:${s.action}`,
        label: s.description,
        group: s.action === 'goInbox' ? 'Go to' : 'Actions',
        keywords: s.keys,
        keycaps: keycapsFor(s.keys),
        run: () => {
          // The drawer listens for inspect requests itself (keys.ts), so it opens from here too.
          if (s.action === 'inspect') requestInspect();
          else perform(s.action);
        },
      });
    }
  }

  if (ctx.mailboxes !== null && ctx.target !== null) {
    const target = ctx.target;
    for (const mailbox of ctx.mailboxes) {
      if (mailbox.id === target.mailboxId) continue;
      commands.push({
        id: `move:${mailbox.id}`,
        label: `Move to ${mailboxLabel(mailbox)}`,
        group: 'Actions',
        keywords: 'move file bucket',
        run: () => {
          ctx.move(target, mailbox);
        },
      });
    }
  }

  // PST-T-9.1 (PST-REQ-142): "Snooze until …" for the conversation under the cursor.
  if (ctx.snooze !== undefined && ctx.target !== null && ctx.target.threadId !== null) {
    const { snooze, target } = ctx;
    for (const choice of snoozeChoices(ctx.now?.() ?? new Date())) {
      commands.push({
        id: `snooze:${choice.label}`,
        label: `Snooze until ${choice.label.toLowerCase()}`,
        group: 'Actions',
        keywords: 'snooze later remind',
        run: () => {
          snooze(target, choice.until);
        },
      });
    }
  }

  if (ctx.mailboxes !== null) {
    for (const mailbox of ctx.mailboxes) {
      const isInbox = mailbox.specialUse === 'inbox' || mailbox.name.toUpperCase() === 'INBOX';
      const keycaps = isInbox ? shortcutKeys('goInbox') : undefined;
      commands.push({
        id: `goto:${mailbox.id}`,
        label: `Go to ${mailboxLabel(mailbox)}`,
        group: 'Go to',
        keywords: 'mailbox folder',
        mailbox,
        ...(keycaps === undefined ? {} : { keycaps }),
        run: () => {
          ctx.navigate(mailPath(mailboxKey(mailbox)));
        },
      });
    }
  }

  // Every other place, straight from the route table — the same entries both navs are built from.
  for (const route of paletteRoutes(isAdmin)) {
    if (route.place === 'auth') continue;
    const keycaps = route.shortcut === undefined ? undefined : shortcutKeys(route.shortcut);
    commands.push({
      id: `nav:${route.path}`,
      label: route.place === 'mail' ? `Go to ${route.title}` : route.title,
      group: PLACE_GROUP[route.place],
      keywords: [route.navGroup ?? '', route.keywords, route.place === 'mail' ? '' : route.place].join(' ').trim(),
      ...(route.hint === undefined ? {} : { hint: route.hint }),
      ...(keycaps === undefined ? {} : { keycaps }),
      run: () => {
        ctx.navigate(route.path);
      },
    });
  }

  const order = (g: CommandGroup): number => COMMAND_GROUPS.indexOf(g);
  // Stable: registry order within a group.
  return commands.map((c, i) => ({ c, i })).sort((a, b) => order(a.c.group) - order(b.c.group) || a.i - b.i).map(({ c }) => c);
}

export interface FuzzyResult {
  score: number;
  /** Positions in `text` that matched the query, in order — for highlighting. */
  indices: number[];
}

/** A subsequence match: every character of `query`, in order, found in `text`. Scores reward
 * consecutive runs and matches at a word boundary, so "rec" ranks "Move to Receipts" above a command
 * that merely contains r, e and c somewhere. Case-insensitive. Null when the query is not a
 * subsequence at all. */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (query === '') return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let qi = 0;
  let previous = -1;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charAt(ti) !== q.charAt(qi)) continue;
    let gain = 1;
    if (previous >= 0 && previous === ti - 1) gain += 3;
    if (ti === 0 || /[\s/_-]/.test(t.charAt(ti - 1))) gain += 2;
    score += gain;
    indices.push(ti);
    previous = ti;
    qi += 1;
  }
  if (qi < q.length) return null;
  // A shorter match target wins a tie: "Reply" over "Reply all" for the same score.
  score -= t.length * 0.01;
  return { score, indices };
}

export interface CommandMatch {
  command: Command;
  /** Indices into `command.label` to highlight; empty when the query is empty. */
  indices: number[];
}

/** Every command when `query` is blank (in registry order); otherwise every command whose label or
 * keywords match `query` as a fuzzy subsequence, best first. */
export function filterCommands(commands: readonly Command[], query: string): CommandMatch[] {
  const trimmed = query.trim();
  if (trimmed === '') return commands.map((command) => ({ command, indices: [] }));

  const scored: { command: Command; indices: number[]; score: number }[] = [];
  for (const command of commands) {
    const onLabel = fuzzyMatch(trimmed, command.label);
    const onKeywords = onLabel === null ? fuzzyMatch(trimmed, command.keywords) : null;
    const best = onLabel ?? onKeywords;
    if (best === null) continue;
    // A label match ranks above a keyword-only match of the same shape. Moving the selected message
    // is the action the palette is most often opened for with one in hand, so it breaks a near-tie
    // against "Go to <same name>" (both match a bucket's name equally well otherwise).
    const relevance = command.id.startsWith('move:') ? 2 : 0;
    scored.push({ command, indices: onLabel !== null ? onLabel.indices : [], score: best.score + (onLabel !== null ? 5 : 0) + relevance });
  }
  scored.sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label));
  return scored.map(({ command, indices }) => ({ command, indices }));
}

export interface CommandSection {
  group: CommandGroup;
  matches: CommandMatch[];
}

/** Matches under their group headers. Groups come in the order their best match does, so the top
 * result is always the first row; within a group the filter's order is kept. */
export function groupMatches(matches: readonly CommandMatch[]): CommandSection[] {
  const sections: CommandSection[] = [];
  for (const match of matches) {
    const section = sections.find((s) => s.group === match.command.group);
    if (section === undefined) sections.push({ group: match.command.group, matches: [match] });
    else section.matches.push(match);
  }
  return sections;
}
