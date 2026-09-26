import { describe, expect, it } from 'vitest';
import { ApiError, INBOUND_STAGES, describeError, isSafeNextPath, queuePath, redirectFor, serverUnreachable, type AuthState } from '../../src/api';

const base: AuthState = { setupRequired: false, oidcConfigured: false, oidcAvailable: false, signedIn: false };
const signedIn = (isAdmin: boolean): AuthState => ({
  ...base,
  signedIn: true,
  account: { id: 'a', displayName: 'A', isAdmin, totpEnabled: true, address: 'a@d3cloud.io' },
});

describe('redirectFor', () => {
  it('sends everything to /setup while no operator exists', () => {
    const state = { ...base, setupRequired: true };
    expect(redirectFor(state, '/')).toBe('/setup');
    expect(redirectFor(state, '/signin')).toBe('/setup');
    expect(redirectFor(state, '/setup')).toBeNull();
  });

  it('sends /setup to /signin once an operator exists (PST-REQ-171)', () => {
    expect(redirectFor(base, '/setup')).toBe('/signin');
    expect(redirectFor(signedIn(true), '/setup')).toBe('/signin');
  });

  it('requires a session for the shell, and leaves /signin once signed in', () => {
    expect(redirectFor(base, '/')).toBe('/signin');
    expect(redirectFor(base, '/signin')).toBeNull();
    expect(redirectFor(signedIn(false), '/signin')).toBe('/');
    expect(redirectFor(signedIn(false), '/')).toBeNull();
  });

  // A non-admin on /admin/* is not bounced to the inbox: the Shell renders the designed no-access
  // state there (PST-T-11.1), and the server refuses every /api/admin call regardless (PST-REQ-007).
  it('does not silently redirect non-admins away from admin screens (PST-REQ-007, PST-T-11.1)', () => {
    expect(redirectFor(signedIn(false), '/admin/sessions')).toBeNull();
    expect(redirectFor(signedIn(true), '/admin/sessions')).toBeNull();
  });

  it('Health and Jobs likewise render no-access for a non-admin rather than redirecting (PST-REQ-127, PST-REQ-128)', () => {
    expect(redirectFor(signedIn(false), '/admin/health')).toBeNull();
    expect(redirectFor(signedIn(false), '/admin/jobs')).toBeNull();
    expect(redirectFor(signedIn(true), '/admin/health')).toBeNull();
    expect(redirectFor(signedIn(true), '/admin/jobs')).toBeNull();
  });

  it('remembers where a session expired away from the inbox, and honours it back only when safe (PST-DA-040)', () => {
    expect(redirectFor(base, '/account/sessions')).toBe('/signin?next=%2Faccount%2Fsessions');
    expect(redirectFor(base, '/mail', '?compose=new')).toBe('/signin?next=%2Fmail%3Fcompose%3Dnew');
    // '/' is already where sign-in lands by default: no next needed.
    expect(redirectFor(base, '/')).toBe('/signin');

    expect(redirectFor(signedIn(false), '/signin', '?next=%2Faccount%2Fsessions')).toBe('/account/sessions');
    // An absent, malformed or unsafe next falls back to the inbox rather than failing closed.
    expect(redirectFor(signedIn(false), '/signin')).toBe('/');
    expect(redirectFor(signedIn(false), '/signin', '?next=not-a-path')).toBe('/');
    expect(redirectFor(signedIn(false), '/signin', '?next=%2F%2Fevil.example')).toBe('/');
    expect(redirectFor(signedIn(false), '/signin', `?next=${encodeURIComponent('https://evil.example')}`)).toBe('/');
  });
});

describe('isSafeNextPath (PST-DA-040)', () => {
  it('allows only a same-origin, single-leading-slash relative path', () => {
    expect(isSafeNextPath('/account/sessions')).toBe(true);
    expect(isSafeNextPath('/mail?compose=new')).toBe(true);
  });
  it('refuses anything that could leave the origin, and empty input', () => {
    expect(isSafeNextPath('')).toBe(false);
    expect(isSafeNextPath('account/sessions')).toBe(false);
    expect(isSafeNextPath('//evil.example')).toBe(false);
    expect(isSafeNextPath('/\\evil.example')).toBe(false);
    expect(isSafeNextPath('https://evil.example')).toBe(false);
    expect(isSafeNextPath('javascript:alert(1)')).toBe(false);
    expect(isSafeNextPath('/ok\r\nSet-Cookie: x=1')).toBe(false);
  });
});

describe('INBOUND_STAGES', () => {
  it('matches the pipeline order the replay endpoint accepts (apps/api/src/admin-jobs/index.ts)', () => {
    expect(INBOUND_STAGES).toEqual(['verify', 'parse', 'classify', 'sieve', 'file', 'notify']);
  });
});

describe('queuePath (PST-T-6.6)', () => {
  it('matches apps/api/src/admin-queue/index.ts one route per scope kind', () => {
    expect(queuePath({ kind: 'recipient', id: 'r1' })).toBe('/api/admin/queue/recipients/r1');
    expect(queuePath({ kind: 'message', id: 'm1' })).toBe('/api/admin/queue/messages/m1');
    expect(queuePath({ kind: 'domain', domain: 'example.com' })).toBe('/api/admin/queue/domains/example.com');
  });

  it('encodes a domain with special characters', () => {
    expect(queuePath({ kind: 'domain', domain: 'exämple.test' })).toBe('/api/admin/queue/domains/ex%C3%A4mple.test');
  });
});

describe('serverUnreachable (PST-DA-050, COPY-18)', () => {
  it('gives one default sentence for "the server did not answer at all"', () => {
    expect(serverUnreachable()).toBe('Postroom didn’t answer. Check your connection and try again.');
  });

  it('lets a caller name a consequence or next step, without inventing its own wording for the shared part', () => {
    expect(serverUnreachable('Nothing changed.')).toBe('Postroom didn’t answer. Nothing changed.');
    expect(serverUnreachable('Try again.')).toBe('Postroom didn’t answer. Try again.');
  });

  it('is what describeError falls back to for a non-ApiError failure, so the two never drift apart', () => {
    expect(describeError(new Error('network'))).toBe(serverUnreachable());
  });
});

describe('describeError', () => {
  it('gives one message for every credential failure', () => {
    expect(describeError(new ApiError(401, 'invalid_credentials', null))).toBe('That address and password don’t match.');
    expect(describeError(new Error('network'))).toMatch(/didn’t answer/);
  });

  it('names which password rule failed (PST-T-4.9, PST-REQ-091)', () => {
    expect(describeError(new ApiError(400, 'weak_password', { error: 'weak_password', problems: ['common'] }))).toMatch(
      /common breached passwords/,
    );
    expect(describeError(new ApiError(400, 'weak_password', { error: 'weak_password', problems: ['too_short'] }))).toMatch(
      /at least 12 characters/,
    );
    expect(describeError(new ApiError(400, 'weak_password', { error: 'weak_password', problems: ['context_word'] }))).toMatch(
      /Postroom's own name/,
    );
    expect(
      describeError(new ApiError(400, 'weak_password', { error: 'weak_password', problems: ['too_short', 'common'] })),
    ).toBe("That password must be at least 12 characters; is one of the most common breached passwords.");
    // No problems array at all: still a sentence, never a crash.
    expect(describeError(new ApiError(400, 'weak_password', null))).toMatch(/too weak/);
  });
});
