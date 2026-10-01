// PST-T-10.3 / PST-REQ-153, PST-T-17.9 (critique 2.4): a row's description leads with the most useful
// fact — when the password was last used (as a relative time close to now, from where), or that it
// never has been — and then when it was made. The times themselves are the shared RelativeTime, so a
// password nobody has used in a year shows a date, not "days ago". Scope tags appear only when a
// password differs from the default (IMAP and SMTP).
import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/components/RelativeTime';
import { DEFAULT_SCOPES, passwordFacts, scopeSummary } from '../../src/screens/app-passwords-format.js';

describe('passwordFacts', () => {
  const createdAt = '2026-09-24T12:00:00.000Z';

  it('says "never used" first, then when it was made, for a password that has not been used', () => {
    expect(passwordFacts({ createdAt, lastUsedAt: null, lastUsedIp: '203.0.113.7' })).toEqual([{ kind: 'never-used' }, { kind: 'created', at: createdAt }]);
  });

  it('leads with the last use and where it came from, then the creation', () => {
    const lastUsedAt = '2026-09-26T11:45:00.000Z';
    expect(passwordFacts({ createdAt, lastUsedAt, lastUsedIp: '203.0.113.7' })).toEqual([
      { kind: 'used', at: lastUsedAt, ip: '203.0.113.7' },
      { kind: 'created', at: createdAt },
    ]);
    expect(passwordFacts({ createdAt, lastUsedAt, lastUsedIp: null })[0]).toEqual({ kind: 'used', at: lastUsedAt, ip: null });
  });

  it('reads its times relative to now, and as a date once they are old', () => {
    const now = new Date('2026-09-26T12:00:00.000Z').getTime();
    expect(relativeTime('2026-09-26T11:45:00.000Z', now)).toBe('15 min ago');
    expect(relativeTime('2026-09-26T06:00:00.000Z', now)).toBe('6 h ago');
    expect(relativeTime('2026-06-01T12:00:00.000Z', now)).not.toMatch(/ago$/);
  });
});

describe('scopeSummary', () => {
  it('shows nothing for the default scopes, in any order', () => {
    expect(scopeSummary(DEFAULT_SCOPES)).toBeNull();
    expect(scopeSummary(['smtp', 'imap'])).toBeNull();
  });

  it('names a password restricted to one thing as "… only"', () => {
    expect(scopeSummary(['imap'])).toBe('IMAP only');
    expect(scopeSummary(['smtp'])).toBe('SMTP only');
    expect(scopeSummary(['dav'])).toBe('DAV only');
  });

  it('lists any other set in a fixed order', () => {
    expect(scopeSummary(['dav', 'smtp', 'imap'])).toBe('IMAP · SMTP · DAV');
    expect(scopeSummary(['sieve', 'imap'])).toBe('IMAP · Sieve');
  });
});
