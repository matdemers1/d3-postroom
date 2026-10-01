// PST-T-9.3: the command palette's registry and fuzzy matcher, pure and DOM-free. The browser
// behaviour — opening with ⌘K, moving a message with it — is e2e/tests/command-palette.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox, MessageSummary } from '../../src/api';
import { buildCommands, COMMAND_GROUPS, filterCommands, fuzzyMatch, groupMatches, keycapsFor, LEAD_ACTIONS, paletteShortcut, type CommandContext } from '../../src/mail/commands';
import { SHORTCUTS } from '../../src/mail/keys';
import { paletteRoutes, ROUTES } from '../../src/routes';

const mailbox = (id: string, name: string, specialUse: Mailbox['specialUse'] = null): Mailbox => ({
  id,
  name,
  specialUse,
  uidvalidity: 1,
  uidnext: 1,
  highestModseq: '1',
  subscribed: true,
  total: 0,
  unseen: 0,
});

const message = (mailboxId: string): MessageSummary => ({
  id: 'msg-1',
  mailboxId,
  uid: 1,
  modseq: '1',
  threadId: null,
  subject: 'Hi',
  from: 'a@b.com',
  date: new Date().toISOString(),
  internalDate: new Date().toISOString(),
  size: 10,
  flags: [],
  bucket: null,
});

const INBOX = mailbox('inbox-id', 'INBOX', 'inbox');
const RECEIPTS = mailbox('receipts-id', 'Receipts');
const NEWSLETTERS = mailbox('newsletters-id', 'Newsletters');

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    mailboxes: [INBOX, RECEIPTS, NEWSLETTERS],
    target: null,
    perform: vi.fn(),
    move: vi.fn(),
    navigate: vi.fn(),
    ...overrides,
  };
}

describe('fuzzyMatch', () => {
  it('matches a subsequence, case-insensitively', () => {
    expect(fuzzyMatch('rec', 'Move to Receipts')).not.toBeNull();
    expect(fuzzyMatch('REC', 'Move to Receipts')).not.toBeNull();
    expect(fuzzyMatch('mvr', 'Move to Receipts')).not.toBeNull(); // m…v…r, in order, need not be contiguous
  });

  it('is null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'Move to Receipts')).toBeNull();
    expect(fuzzyMatch('tecris', 'Move to Receipts')).toBeNull();
  });

  it('scores a contiguous, word-start match above a scattered one', () => {
    const tight = fuzzyMatch('rec', 'Move to Receipts');
    const loose = fuzzyMatch('rec', 'Reply all, then cc');
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight?.score ?? -Infinity).toBeGreaterThan(loose?.score ?? Infinity);
  });

  it('returns the empty query as a universal, zero-index match', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });
});

describe('buildCommands', () => {
  it('exposes every keyboard action from SHORTCUTS except the palette itself', () => {
    const commands = buildCommands(context());
    const actionIds = new Set(commands.filter((c) => c.id.startsWith('action:')).map((c) => c.id));
    for (const s of SHORTCUTS) {
      if (s.action === 'commandPalette') {
        expect(actionIds.has(`action:${s.action}`)).toBe(false);
        continue;
      }
      if (s.action === 'goInbox') {
        // With mailboxes loaded, g then i rides on "Go to Inbox" instead of a second row.
        expect(commands.find((c) => c.label === 'Go to Inbox')?.keycaps).toEqual(['g', 'then', 'i']);
        continue;
      }
      expect(actionIds.has(`action:${s.action}`)).toBe(true);
    }
  });

  it('keeps g then i as its own command while the mailboxes are still loading', () => {
    const commands = buildCommands(context({ mailboxes: null }));
    expect(commands.some((c) => c.id === 'action:goInbox' && c.group === 'Go to')).toBe(true);
  });

  it('lists no keyboard actions outside Mail (no perform), but still every place', () => {
    const ctx: CommandContext = context();
    delete ctx.perform;
    const commands = buildCommands(ctx);
    expect(commands.some((c) => c.id.startsWith('action:'))).toBe(false);
    expect(commands.some((c) => c.group === 'Settings')).toBe(true);
  });

  it('carries keycaps from keys.ts, and only where a binding exists (PST-T-14.3)', () => {
    const commands = buildCommands(context());
    const withCaps = commands.filter((c) => c.keycaps !== undefined);
    const bound = new Set(SHORTCUTS.map((s) => keycapsFor(s.keys).join(' ')));
    for (const c of withCaps) expect(bound.has((c.keycaps ?? []).join(' '))).toBe(true);
    expect(commands.find((c) => c.id === 'action:reply')?.keycaps).toEqual(['r']);
    expect(commands.find((c) => c.id === 'action:markUnread')?.keycaps).toEqual(['Shift', 'u']);
    expect(commands.find((c) => c.label === 'Rules')?.keycaps).toBeUndefined();
  });

  it('is grouped Actions, Go to, Settings, Admin — in that order', () => {
    expect([...COMMAND_GROUPS]).toEqual(['Actions', 'Go to', 'Settings', 'Admin']);
    const commands = buildCommands(context({ target: message(INBOX.id) }), true);
    const groups = [...new Set(commands.map((c) => c.group))];
    expect(groups).toEqual([...COMMAND_GROUPS]);
  });

  it('lists every place in the route table: all of them for an admin, none of Admin otherwise', () => {
    const asAdmin = buildCommands(context(), true);
    for (const route of paletteRoutes(true)) {
      expect(asAdmin.some((c) => c.id === `nav:${route.path}`), route.path).toBe(true);
    }
    const asOperator = buildCommands(context(), false);
    expect(asOperator.some((c) => c.group === 'Admin')).toBe(false);
    for (const route of ROUTES.filter((r) => r.palette && !r.adminOnly)) {
      expect(asOperator.some((c) => c.id === `nav:${route.path}`), route.path).toBe(true);
    }
  });

  it('running a place command navigates to its path', () => {
    const navigate = vi.fn();
    const commands = buildCommands(context({ navigate }));
    commands.find((c) => c.label === 'Browser sessions')?.run();
    expect(navigate).toHaveBeenCalledWith('/settings/security/sessions');
  });

  it('old names survive as searchable hints: "devices" finds Security & devices and Sign-in sessions', () => {
    const labels = filterCommands(buildCommands(context(), true), 'devices').map((m) => m.command.label);
    expect(labels).toContain('Browser sessions');
    expect(labels).toContain('Devices');
    expect(labels).toContain('Sign-in sessions');
  });

  it('offers "Move to <bucket>" for every other mailbox when a message is selected', () => {
    const commands = buildCommands(context({ target: message(INBOX.id) }));
    const moveLabels = commands.filter((c) => c.id.startsWith('move:')).map((c) => c.label);
    expect(moveLabels).toContain('Move to Receipts');
    expect(moveLabels).toContain('Move to Newsletters');
    expect(moveLabels).not.toContain('Move to Inbox'); // already there
  });

  it('offers no "Move to" commands with nothing selected', () => {
    const commands = buildCommands(context({ target: null }));
    expect(commands.some((c) => c.id.startsWith('move:'))).toBe(false);
  });

  it('running "Move to Receipts" calls move() with the target and the Receipts mailbox', () => {
    const move = vi.fn();
    const target = message(INBOX.id);
    const commands = buildCommands(context({ target, move }));
    const moveToReceipts = commands.find((c) => c.label === 'Move to Receipts');
    expect(moveToReceipts).toBeDefined();
    moveToReceipts?.run();
    expect(move).toHaveBeenCalledWith(target, RECEIPTS);
  });

  it('offers "Go to <mailbox>" for every mailbox and navigates the mail path on run', () => {
    const navigate = vi.fn();
    const commands = buildCommands(context({ navigate }));
    const goToReceipts = commands.find((c) => c.label === 'Go to Receipts');
    expect(goToReceipts).toBeDefined();
    goToReceipts?.run();
    // A bucket routes by its slug (PST-T-16.4, PST-REQ-198).
    expect(navigate).toHaveBeenCalledWith('/mail/receipts');
  });

  it('offers the Settings screens, and the Admin screens only for an admin', () => {
    const asOperator = buildCommands(context(), false).map((c) => c.label);
    const asAdmin = buildCommands(context(), true).map((c) => c.label);
    expect(asOperator).toContain('Devices');
    expect(asOperator).toContain('Encryption keys');
    expect(asOperator).not.toContain('Health');
    expect(asAdmin).toContain('Health');
    expect(asAdmin).toContain('Live SMTP');
  });

  it('running a keyboard-action command calls perform() with that action', () => {
    const perform = vi.fn();
    const commands = buildCommands(context({ perform }));
    const archive = commands.find((c) => c.id === 'action:archive');
    archive?.run();
    expect(perform).toHaveBeenCalledWith('archive');
  });
});

describe('filterCommands', () => {
  it('returns every command, unscored, for a blank query', () => {
    const commands = buildCommands(context());
    const matches = filterCommands(commands, '  ');
    expect(matches.map((m) => m.command.id)).toEqual(commands.map((c) => c.id));
    expect(matches.every((m) => m.indices.length === 0)).toBe(true);
  });

  it('"rec" surfaces Move to Receipts at the top for a message not already in it', () => {
    const commands = buildCommands(context({ target: message(INBOX.id) }));
    const matches = filterCommands(commands, 'rec');
    expect(matches[0]?.command.label).toBe('Move to Receipts');
    expect(matches[0]?.indices.length).toBeGreaterThan(0);
  });

  it('groups matches in the order of their best member, so the top result stays first', () => {
    const matches = filterCommands(buildCommands(context({ target: message(INBOX.id) })), 'rec');
    const sections = groupMatches(matches);
    expect(sections[0]?.matches[0]?.command.label).toBe('Move to Receipts');
    expect(sections.flatMap((s) => s.matches)).toHaveLength(matches.length);
    expect(new Set(sections.map((s) => s.group)).size).toBe(sections.length);
  });

  it('drops commands that do not match at all', () => {
    const commands = buildCommands(context());
    const matches = filterCommands(commands, 'zzzzz-not-a-command');
    expect(matches).toEqual([]);
  });
});

describe('the Actions group (PST-T-15.5)', () => {
  it('leads with Archive, Snooze and Move — with their keys — when a conversation is open', () => {
    const actions = buildCommands(context({ target: message(INBOX.id) })).filter((c) => c.group === 'Actions');
    expect(actions.slice(0, 3).map((c) => c.id)).toEqual(LEAD_ACTIONS.map((a) => `action:${a}`));
    expect(actions.slice(0, 3).map((c) => c.keycaps)).toEqual([['e'], ['b'], ['v']]);
  });

  it('keeps the keyboard order with nothing in hand', () => {
    const actions = buildCommands(context({ target: null })).filter((c) => c.id.startsWith('action:') && c.group === 'Actions');
    const order = SHORTCUTS.filter((s) => actions.some((c) => c.id === `action:${s.action}`)).map((s) => `action:${s.action}`);
    expect(actions.map((c) => c.id)).toEqual(order);
  });

  it('carries the mailbox on "Go to <mailbox>", so the palette can draw its icon', () => {
    const goTo = buildCommands(context()).find((c) => c.label === 'Go to Receipts');
    expect(goTo?.mailbox).toBe(RECEIPTS);
  });
});

describe('paletteShortcut', () => {
  it('draws one key cap per key: a sequence without "then", the first of alternatives', () => {
    expect(paletteShortcut(['g', 'then', 'i'])).toEqual(['g', 'i']);
    expect(paletteShortcut(['o', 'or', 'Enter'])).toEqual(['o']);
    expect(paletteShortcut(['Shift', 'u'])).toEqual(['Shift', 'u']);
    expect(paletteShortcut(['e'])).toEqual(['e']);
  });
});
