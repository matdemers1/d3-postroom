import { describe, expect, it } from 'vitest';
import { ApiError, INBOUND_STAGES, describeError, redirectFor, type AuthState } from '../../src/api';

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

  it('keeps non-admins out of admin screens (PST-REQ-007)', () => {
    expect(redirectFor(signedIn(false), '/admin/sessions')).toBe('/');
    expect(redirectFor(signedIn(true), '/admin/sessions')).toBeNull();
  });

  it('keeps non-admins out of Health and Jobs too (PST-REQ-127, PST-REQ-128)', () => {
    expect(redirectFor(signedIn(false), '/admin/health')).toBe('/');
    expect(redirectFor(signedIn(false), '/admin/jobs')).toBe('/');
    expect(redirectFor(signedIn(true), '/admin/health')).toBeNull();
    expect(redirectFor(signedIn(true), '/admin/jobs')).toBeNull();
  });
});

describe('INBOUND_STAGES', () => {
  it('matches the pipeline order the replay endpoint accepts (apps/api/src/admin-jobs/index.ts)', () => {
    expect(INBOUND_STAGES).toEqual(['verify', 'parse', 'classify', 'sieve', 'file', 'notify']);
  });
});

describe('describeError', () => {
  it('gives one message for every credential failure', () => {
    expect(describeError(new ApiError(401, 'invalid_credentials', null))).toBe('Those details did not match.');
    expect(describeError(new Error('network'))).toMatch(/did not answer/);
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
