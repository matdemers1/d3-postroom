// PST-T-9.1: the state behind the composer's Send later / Remind me controls, the undo-send toast's
// countdown, the snooze choices and the palette's snooze commands — pure and DOM-free. The server
// behaviour (hold, undo, release exactly once, snooze and return, remind) is the api and worker
// integration suites.
import { describe, expect, it, vi } from 'vitest';
import type { MessageSummary, PendingSend, SendResult } from '../../src/api';
import { isHeld, REMIND_CHOICES, secondsLeft, sendOptions, setUndoSeconds, snoozeChoices, toastState, toLocalInput, undoSeconds, UNDO_DEFAULT_SECONDS } from '../../src/mail/compose';
import { buildCommands } from '../../src/mail/commands';

const NOW = new Date(2026, 8, 26, 10, 0, 0); // Sat 26 Sep 2026, 10:00 local

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const pending = (extra: Partial<PendingSend> = {}): PendingSend => ({
  id: 'p1',
  kind: 'undo',
  state: 'held',
  releaseAt: new Date(NOW.getTime() + 10_000).toISOString(),
  draftId: 'd1',
  subject: 'Hi',
  to: 'alice@example.org',
  messageId: '<m@d3cloud.io>',
  remindAfterSeconds: null,
  reason: null,
  createdAt: NOW.toISOString(),
  ...extra,
});

describe('the undo window setting (PST-REQ-140)', () => {
  it('defaults to 10 s, clamps to 0–30, and ignores garbage', () => {
    expect(undoSeconds(null)).toBe(UNDO_DEFAULT_SECONDS);
    expect(undoSeconds(memoryStorage())).toBe(10);
    expect(undoSeconds(memoryStorage({ 'postroom.undoSeconds': '0' }))).toBe(0);
    expect(undoSeconds(memoryStorage({ 'postroom.undoSeconds': '99' }))).toBe(30);
    expect(undoSeconds(memoryStorage({ 'postroom.undoSeconds': '-4' }))).toBe(10);
    const s = memoryStorage();
    setUndoSeconds(s, 45);
    expect(undoSeconds(s)).toBe(30);
    setUndoSeconds(s, 5);
    expect(undoSeconds(s)).toBe(5);
  });
});

describe('sendOptions: what Send and Schedule ask the server for', () => {
  it('Send now holds for the undo window; 0 sends straight away', () => {
    expect(sendOptions({ kind: 'now' }, 10, null, NOW)).toEqual({ ok: true, options: { undoSeconds: 10 } });
    expect(sendOptions({ kind: 'now' }, 0, null, NOW)).toEqual({ ok: true, options: {} });
  });

  it('Send later sends the chosen local time as an ISO instant, and only a future one (PST-REQ-141)', () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(sendOptions({ kind: 'later', local: toLocalInput(later) }, 10, null, NOW)).toEqual({ ok: true, options: { sendAt: later.toISOString() } });
    expect(sendOptions({ kind: 'later', local: toLocalInput(new Date(NOW.getTime() - 60_000)) }, 10, null, NOW)).toEqual({ ok: false, error: 'Pick a time in the future to send it.' });
    expect(sendOptions({ kind: 'later', local: '' }, 10, null, NOW).ok).toBe(false);
  });

  it('Remind me adds remindAfterSeconds either way (PST-REQ-143)', () => {
    const day = REMIND_CHOICES.find((c) => c.seconds === 86_400)?.seconds ?? null;
    expect(sendOptions({ kind: 'now' }, 10, day, NOW)).toEqual({ ok: true, options: { undoSeconds: 10, remindAfterSeconds: 86_400 } });
    expect(REMIND_CHOICES[0]?.seconds).toBeNull();
  });

  it('toLocalInput is a datetime-local value to the minute', () => {
    expect(toLocalInput(NOW)).toBe('2026-09-26T10:00');
  });
});

describe('the undo toast (PST-REQ-140)', () => {
  it('knows a held answer from a sent one', () => {
    const sent: SendResult = { messageId: '<m>', outboundId: 'o', sentMessageId: 's', sentMailboxId: 'b', threadId: null };
    expect(isHeld(pending())).toBe(true);
    expect(isHeld(sent)).toBe(false);
  });

  it('counts down with Undo, then says Sent. and offers no Undo', () => {
    expect(toastState(pending(), NOW)).toEqual({ text: 'Sending… 10 s', canUndo: true, done: false });
    expect(toastState(pending(), new Date(NOW.getTime() + 9_100))).toEqual({ text: 'Sending… 1 s', canUndo: true, done: false });
    expect(toastState(pending(), new Date(NOW.getTime() + 10_000))).toEqual({ text: 'Sent.', canUndo: false, done: true });
    expect(secondsLeft(pending().releaseAt, new Date(NOW.getTime() + 60_000))).toBe(0);
  });

  it('a scheduled send says when, and can be undone until then', () => {
    const s = toastState(pending({ kind: 'scheduled', releaseAt: new Date(NOW.getTime() + 86_400_000).toISOString() }), NOW, 'en-US');
    expect(s.text).toMatch(/^Scheduled for /);
    expect(s.canUndo).toBe(true);
  });
});

describe('snooze choices (PST-REQ-142)', () => {
  it('later today, tomorrow at 08:00 and next Monday at 08:00, all in the future', () => {
    const choices = snoozeChoices(NOW);
    expect(choices.map((c) => c.label)).toEqual(['Later today', 'Tomorrow morning', 'Next week']);
    expect(choices[0]?.until.getHours()).toBe(13);
    expect(choices[1]?.until).toEqual(new Date(2026, 8, 27, 8, 0, 0));
    expect(choices[2]?.until).toEqual(new Date(2026, 8, 28, 8, 0, 0)); // Monday
    for (const c of choices) expect(c.until.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('late in the evening there is no "later today"; on a Monday "next week" is a week out', () => {
    expect(snoozeChoices(new Date(2026, 8, 26, 22, 30)).map((c) => c.label)).toEqual(['Tomorrow morning', 'Next week']);
    expect(snoozeChoices(new Date(2026, 8, 28, 9, 0))[2]?.until).toEqual(new Date(2026, 9, 5, 8, 0, 0));
  });

  it('the command palette offers "Snooze until …" for a threaded message, and runs the snooze', () => {
    const target: MessageSummary = {
      id: 'msg-1',
      mailboxId: 'inbox',
      uid: 1,
      modseq: '1',
      threadId: 'thread-1',
      subject: 'Hi',
      from: 'a@b.com',
      date: NOW.toISOString(),
      internalDate: NOW.toISOString(),
      size: 10,
      flags: [],
      bucket: null,
    };
    const snooze = vi.fn();
    const base = { mailboxes: [], perform: vi.fn(), move: vi.fn(), navigate: vi.fn(), now: () => NOW };
    const commands = buildCommands({ ...base, target, snooze });
    const found = commands.filter((c) => c.id.startsWith('snooze:'));
    expect(found.map((c) => c.label)).toEqual(['Snooze until later today', 'Snooze until tomorrow morning', 'Snooze until next week']);
    found[1]?.run();
    expect(snooze).toHaveBeenCalledWith(target, new Date(2026, 8, 27, 8, 0, 0));
    // No snooze handler, or no conversation: no snooze commands.
    expect(buildCommands({ ...base, target }).some((c) => c.id.startsWith('snooze:'))).toBe(false);
    expect(buildCommands({ ...base, target: { ...target, threadId: null }, snooze }).some((c) => c.id.startsWith('snooze:'))).toBe(false);
  });
});
