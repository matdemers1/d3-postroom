// PST-T-20.2/20.3 in the console: the invite link's two shapes, the invite page's place in the route
// table, and the words Admin › People uses for an account's standing and an invite's state.
import { describe, expect, it, vi } from 'vitest';

// @d3cloud/ui's dist imports its own CSS, which Node cannot load; nothing here renders it.
vi.mock('@d3cloud/ui', () => {
  const stub = (props: { children?: unknown }) => props.children ?? null;
  return new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : stub) });
});

import { routeForPath } from '../../src/routes';
import { countOf, inviteStatus, personStatus } from '../../src/screens/AdminPeople';
import { inviteTokenOf, isInvitePath } from '../../src/screens/invite/token';

const TOKEN = 'Zt3Q9_x-abcdefghijklmnopqrstuvwxyz0123456789';

describe('invite links (PST-T-20.2)', () => {
  it('reads /invite/<token> and /invite?token=, and nothing else', () => {
    expect(inviteTokenOf(`/invite/${TOKEN}`, '')).toBe(TOKEN);
    expect(inviteTokenOf(`/invite/${TOKEN}/`, '')).toBe(TOKEN);
    expect(inviteTokenOf('/invite', `?token=${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenOf('/invite/', `?token=${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenOf('/invite', '?token=short')).toBeNull();
    expect(inviteTokenOf('/invite/has spaces in it here', '')).toBeNull();
    expect(inviteTokenOf(`/signin/${TOKEN}`, '')).toBeNull();
  });

  it('is a shell-less page before any sign-in, named in the tab', () => {
    expect(isInvitePath(`/invite/${TOKEN}`)).toBe(true);
    expect(isInvitePath('/invite')).toBe(true);
    expect(isInvitePath('/invites-elsewhere')).toBe(false);
    expect(routeForPath(`/invite/${TOKEN}`)).toMatchObject({ id: 'invite', place: 'auth', title: 'Accept invite' });
    expect(routeForPath('/admin/people')).toMatchObject({ id: 'adminPeople', adminOnly: true });
  });
});

describe('Admin › People (PST-T-20.2, PST-T-20.3)', () => {
  it('says where each account stands', () => {
    expect(personStatus({ disabledAt: null, deleteAfter: null, secondFactor: 'enrolled' })).toEqual({ tone: 'neutral', words: 'Active' });
    expect(personStatus({ disabledAt: null, deleteAfter: null, secondFactor: 'none' })).toEqual({ tone: 'attention', words: 'Setting up' });
    expect(personStatus({ disabledAt: '2026-10-04T00:00:00Z', deleteAfter: '2026-10-11T00:00:00Z', secondFactor: 'enrolled' })).toEqual({ tone: 'warning', words: 'Deleting' });
    expect(personStatus({ disabledAt: '2026-10-04T00:00:00Z', deleteAfter: null, secondFactor: 'enrolled' })).toEqual({ tone: 'idle', words: 'Disabled' });
  });

  it('counts each list in words', () => {
    expect(countOf(1, 'account')).toBe('1 account');
    expect(countOf(3, 'invite')).toBe('3 invites');
  });

  it('names an invite by its state', () => {
    expect(inviteStatus({ state: 'pending' })).toEqual({ tone: 'attention', words: 'Waiting' });
    expect(inviteStatus({ state: 'accepted' }).words).toBe('Accepted');
    expect(inviteStatus({ state: 'revoked' }).words).toBe('Withdrawn');
    expect(inviteStatus({ state: 'expired' }).words).toBe('Expired');
  });
});
