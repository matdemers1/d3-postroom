// PST-T-14.1 (design audit INT): a failed snooze is never reported like a successful one. The
// control keeps the message open and shows the error inline; only a success reaches onDone (which
// says "Snoozed" and closes the message).
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/api';
import { attemptSnooze } from '../../src/mail/Scheduled';

vi.mock('@d3cloud/ui', () => ({}));

describe('attemptSnooze', () => {
  it('passes the success sentence through', async () => {
    expect(await attemptSnooze(() => Promise.resolve({}), 'Snoozed until Tue 9:00 AM.')).toEqual({ ok: true, text: 'Snoozed until Tue 9:00 AM.' });
  });

  it('reports a network failure as a failure, never as "Snoozed"', async () => {
    const outcome = await attemptSnooze(() => Promise.reject(new TypeError('fetch failed')), 'Snoozed until Tue 9:00 AM.');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).not.toMatch(/Snoozed/);
    expect(outcome.text).toMatch(/Nothing changed/);
  });

  it('reports a refusal as a failure', async () => {
    const refused = await attemptSnooze(() => Promise.reject(new ApiError(500, 'internal', null)), 'Snoozed.');
    expect(refused).toEqual({ ok: false, text: 'Postroom couldn’t snooze it. Nothing changed.' });
    const gone = await attemptSnooze(() => Promise.reject(new ApiError(404, 'not_found', null)), 'Snoozed.');
    expect(gone.ok).toBe(false);
  });
});
