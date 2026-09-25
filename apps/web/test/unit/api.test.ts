import { describe, expect, it } from 'vitest';
import { ApiError, describeError, redirectFor, type AuthState } from '../../src/api';

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
});

describe('describeError', () => {
  it('gives one message for every credential failure', () => {
    expect(describeError(new ApiError(401, 'invalid_credentials', null))).toBe('Those details did not match.');
    expect(describeError(new Error('network'))).toMatch(/did not answer/);
  });
});
