// PST-T-9.3: the command palette's registry and fuzzy matcher, pure and DOM-free. The browser
// behaviour — opening with ⌘K, moving a message with it — is e2e/tests/command-palette.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import type { Mailbox, MessageSummary } from '../../src/api';
import { buildCommands, filterCommands, fuzzyMatch, type CommandContext } from '../../src/mail/commands';
import { SHORTCUTS } from '../../src/mail/keys';

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
      expect(actionIds.has(`action:${s.action}`)).toBe(true);
    }
  });

  it('offers "Move to <bucket>" for every other mailbox when a message is selected', () => {
    const commands = buildCommands(context({ target: message(INBOX.id) }));
    const moveLabels = commands.filter((c) => c.group === 'Move').map((c) => c.label);
    expect(moveLabels).toContain('Move to Receipts');
    expect(moveLabels).toContain('Move to Newsletters');
    expect(moveLabels).not.toContain('Move to Inbox'); // already there
  });

  it('offers no "Move to" commands with nothing selected', () => {
    const commands = buildCommands(context({ target: null }));
    expect(commands.some((c) => c.group === 'Move')).toBe(false);
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
    expect(navigate).toHaveBeenCalledWith(`/mail/${RECEIPTS.id}`);
  });

  it('offers the account screens, and the admin screens only for an admin', () => {
    const asOperator = buildCommands(context(), false).map((c) => c.label);
    const asAdmin = buildCommands(context(), true).map((c) => c.label);
    expect(asOperator).toContain('Go to App passwords');
    expect(asOperator).not.toContain('Go to Admin health');
    expect(asAdmin).toContain('Go to Admin health');
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

  it('drops commands that do not match at all', () => {
    const commands = buildCommands(context());
    const matches = filterCommands(commands, 'zzzzz-not-a-command');
    expect(matches).toEqual([]);
  });
});
