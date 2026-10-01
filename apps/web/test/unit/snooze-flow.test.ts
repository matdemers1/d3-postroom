// PST-T-16.1 (PST-REQ-142, PST-REQ-190, PST-DA-071): what a finished snooze means. The triage-path
// snooze removes the row, advances and shows "Snoozed until …" only for conversations the server
// actually snoozed; a failure is an error and nothing else. The browser half is e2e/tests/triage.spec.ts.
import { describe, expect, it } from 'vitest';
import { settleSnooze } from '../../src/mail/list/triage';

describe('settleSnooze', () => {
  it('every conversation snoozed: all done, no error', () => {
    expect(settleSnooze([{ threadId: 'a', ok: true }, { threadId: 'b', ok: true }])).toEqual({ done: ['a', 'b'], failed: [], error: null });
  });

  it('a refusal: nothing done (so no toast, nothing leaves), and the error says it is still there', () => {
    const s = settleSnooze([{ threadId: 'a', ok: false, status: 500 }]);
    expect(s.done).toEqual([]);
    expect(s.failed).toEqual(['a']);
    expect(s.error).toBe('Couldn’t snooze that — it’s still here.');
  });

  it('a partial failure keeps the successes and names how many stayed', () => {
    const s = settleSnooze([
      { threadId: 'a', ok: true },
      { threadId: 'b', ok: false, status: 500 },
      { threadId: 'c', ok: false, status: 503 },
    ]);
    expect(s.done).toEqual(['a']);
    expect(s.failed).toEqual(['b', 'c']);
    expect(s.error).toBe('Couldn’t snooze 2 conversations — they’re still here.');
  });

  it('a conversation that is gone, and a server that never answered, each say so', () => {
    expect(settleSnooze([{ threadId: 'a', ok: false, status: 404 }]).error).toBe('That conversation is gone, so it wasn’t snoozed.');
    expect(settleSnooze([{ threadId: 'a', ok: false, status: null }]).error).toBe('Postroom didn’t answer. It wasn’t snoozed.');
  });

  it('never reports success for nothing: no attempts, no error, nothing done', () => {
    expect(settleSnooze([])).toEqual({ done: [], failed: [], error: null });
  });
});
