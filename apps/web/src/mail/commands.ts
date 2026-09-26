// The command palette's registry (PST-T-9.3, PST-REQ-147): every keyboard action from keys.ts (so
// the palette can never list one that does nothing, the same guarantee ShortcutsOverlay makes), a
// "Move to <bucket>" command per mailbox for the message under the cursor, "Go to <mailbox>" for
// every mailbox, and navigation to the account/admin screens. Pure and DOM-free, so the registry
// and the fuzzy matcher are unit-tested without a browser.
import type { Mailbox, MessageSummary } from '../api';
import { snoozeChoices } from './compose';
import { mailboxLabel } from './format';
import { SHORTCUTS, type MailAction } from './keys';
import { mailPath } from './route';

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Extra text a query can match against, beyond the label (a shortcut key, a synonym). */
  keywords: string;
  run: () => void;
}

export interface CommandContext {
  mailboxes: readonly Mailbox[] | null;
  /** The message the cursor or the reading pane is on, if any — what "Move to X" acts on. */
  target: MessageSummary | null;
  perform: (action: MailAction) => void;
  move: (message: MessageSummary, mailbox: Mailbox) => void;
  navigate: (path: string) => void;
  /** PST-T-9.1: snooze the target's conversation until a time (absent: no snooze commands). */
  snooze?: (message: MessageSummary, until: Date) => void;
  /** The clock snooze choices are relative to (tests pin it). */
  now?: () => Date;
}

interface AppScreen {
  path: string;
  label: string;
  /** Only shown to an admin account. */
  admin?: boolean;
}

/** Every non-mail screen Postroom has today (Shell.tsx's SideNav), so the palette never links to a
 * page the app does not have. */
export const APP_SCREENS: readonly AppScreen[] = [
  { path: '/app-passwords', label: 'Go to App passwords' },
  { path: '/account/password', label: 'Go to Change password' },
  { path: '/account/sessions', label: 'Go to Devices' },
  { path: '/account/import', label: 'Go to Import mail' },
  { path: '/admin/sessions', label: 'Go to Admin sessions', admin: true },
  { path: '/admin/health', label: 'Go to Admin health', admin: true },
  { path: '/admin/jobs', label: 'Go to Admin jobs', admin: true },
  { path: '/admin/queue', label: 'Go to Outbound queue', admin: true },
];

/** Builds the full, ungrouped command list for the current context. */
export function buildCommands(ctx: CommandContext, isAdmin = true): Command[] {
  const commands: Command[] = [];

  for (const s of SHORTCUTS) {
    // The palette opens itself; a command that opens the thing it is already inside of is noise.
    if (s.action === 'commandPalette') continue;
    commands.push({
      id: `action:${s.action}`,
      label: s.description,
      group: 'Action',
      keywords: s.keys,
      run: () => {
        ctx.perform(s.action);
      },
    });
  }

  if (ctx.mailboxes !== null) {
    for (const mailbox of ctx.mailboxes) {
      commands.push({
        id: `goto:${mailbox.id}`,
        label: `Go to ${mailboxLabel(mailbox)}`,
        group: 'Navigate',
        keywords: 'mailbox folder',
        run: () => {
          ctx.navigate(mailPath(mailbox.id));
        },
      });
    }

    if (ctx.target !== null) {
      const target = ctx.target;
      for (const mailbox of ctx.mailboxes) {
        if (mailbox.id === target.mailboxId) continue;
        commands.push({
          id: `move:${mailbox.id}`,
          label: `Move to ${mailboxLabel(mailbox)}`,
          group: 'Move',
          keywords: 'move file bucket',
          run: () => {
            ctx.move(target, mailbox);
          },
        });
      }
    }
  }

  // PST-T-9.1 (PST-REQ-142): "Snooze until …" for the conversation under the cursor.
  if (ctx.snooze !== undefined && ctx.target !== null && ctx.target.threadId !== null) {
    const { snooze, target } = ctx;
    for (const choice of snoozeChoices(ctx.now?.() ?? new Date())) {
      commands.push({
        id: `snooze:${choice.label}`,
        label: `Snooze until ${choice.label.toLowerCase()}`,
        group: 'Action',
        keywords: 'snooze later remind',
        run: () => {
          snooze(target, choice.until);
        },
      });
    }
  }

  for (const screen of APP_SCREENS) {
    if (screen.admin === true && !isAdmin) continue;
    commands.push({
      id: `nav:${screen.path}`,
      label: screen.label,
      group: 'Go to',
      keywords: 'settings screen',
      run: () => {
        ctx.navigate(screen.path);
      },
    });
  }

  return commands;
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
    const relevance = command.group === 'Move' ? 2 : 0;
    scored.push({ command, indices: onLabel !== null ? onLabel.indices : [], score: best.score + (onLabel !== null ? 5 : 0) + relevance });
  }
  scored.sort((a, b) => b.score - a.score || a.command.label.localeCompare(b.command.label));
  return scored.map(({ command, indices }) => ({ command, indices }));
}
