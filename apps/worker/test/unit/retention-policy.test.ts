// PST-T-7.7 (PST-REQ-129): which mailboxes expire, which move to Trash, and which keep everything.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_DAYS, effectiveDays, retentionAction } from '../../src/retention/policy.js';

describe('retention policy', () => {
  it('defaults: Junk 30 d to Trash, Trash 30 d expire, Rejects 14 d expire, everything else forever', () => {
    expect(retentionAction('junk', undefined)).toEqual({ kind: 'to-trash', days: 30 });
    expect(retentionAction('trash', undefined)).toEqual({ kind: 'expire-trash', days: 30 });
    expect(retentionAction('rejects', undefined)).toEqual({ kind: 'expire-rejects', days: 14 });
    for (const use of ['inbox', 'sent', 'drafts', 'archive', null] as const) expect(retentionAction(use, undefined)).toBeNull();
  });

  it('a policy row wins; days null turns a default off', () => {
    expect(retentionAction('junk', 7)).toEqual({ kind: 'to-trash', days: 7 });
    expect(retentionAction('junk', null)).toBeNull();
    expect(retentionAction('trash', null)).toBeNull();
    expect(retentionAction(null, 90)).toEqual({ kind: 'to-trash', days: 90 });
    expect(effectiveDays('inbox', 365)).toBe(365);
  });

  it('only Trash and Rejects ever expire; every other policy is a move to Trash', () => {
    for (const use of ['inbox', 'sent', 'drafts', 'archive', 'junk', null] as const) {
      expect(retentionAction(use, 1)?.kind).toBe('to-trash');
    }
  });

  it('Rejects matches smtp-in (the date it records in the verdict)', () => {
    expect(DEFAULT_RETENTION_DAYS.rejects).toBe(14);
  });
});
