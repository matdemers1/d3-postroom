// PST-T-14.8 (PST-REQ-155, PST-REQ-192, PST-ADR-011): the phone's one push stack — each screen's
// depth, the direction a move slides, and where each screen's Back goes. The browser half (390 px,
// 44 px targets, no overflow, axe) is e2e/tests/mobile.spec.ts.
import { describe, expect, it } from 'vitest';
import { contextParent, contextTitle, placeIndexFor, pushDepth, pushDirection } from '../../src/mobile/push';

const BOX = '0b6f2a8e-8c1f-4c43-9d7c-3f7b1a2e4d5c';
const MSG = '6c1e0f9a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('pushDepth', () => {
  it('Mailboxes → list → thread → composer, one level each', () => {
    expect(pushDepth('/mail')).toBe(0);
    expect(pushDepth('/')).toBe(1);
    expect(pushDepth(`/mail/${BOX}`)).toBe(1);
    expect(pushDepth(`/mail/${BOX}/${MSG}`)).toBe(2);
    expect(pushDepth(`/mail/${BOX}/${MSG}`, '?compose=reply')).toBe(3);
    expect(pushDepth('/', '?compose=new')).toBe(2);
  });

  it('Settings and the Admin console push from Mailboxes too', () => {
    expect(pushDepth('/settings')).toBe(1);
    expect(pushDepth('/settings/rules')).toBe(2);
    expect(pushDepth('/admin')).toBe(2);
    expect(pushDepth('/admin/queue')).toBe(3);
    expect(pushDepth('/calendar')).toBe(1);
    expect(pushDepth('/contacts/new')).toBe(2);
    expect(pushDepth('/senders/a%40b.example')).toBe(3);
  });
});

describe('pushDirection', () => {
  it('deeper slides forward, shallower reverses, a first paint or a sideways move does not slide', () => {
    expect(pushDirection(1, 2)).toBe('forward');
    expect(pushDirection(2, 1)).toBe('back');
    expect(pushDirection(2, 2)).toBe('none');
    expect(pushDirection(null, 2)).toBe('none');
  });
});

describe('context bar', () => {
  it('names the parent on every non-mail screen', () => {
    expect(contextParent('/settings', '/', 'Inbox')).toEqual({ to: '/mail', label: 'Mailboxes' });
    expect(contextParent('/settings/security/devices', '/', 'Inbox')).toEqual({ to: '/settings', label: 'Settings' });
    expect(contextParent('/admin', '/', 'Inbox')).toEqual({ to: '/settings', label: 'Settings' });
    expect(contextParent('/admin/dns', '/', 'Inbox')).toEqual({ to: '/admin', label: 'Admin' });
    expect(contextParent('/calendar', '/', 'Inbox')).toEqual({ to: '/mail', label: 'Mailboxes' });
    expect(contextParent('/contacts/new', '/', 'Inbox')).toEqual({ to: '/contacts', label: 'Contacts' });
    expect(contextParent('/senders/a%40b.example', `/mail/${BOX}`, 'Updates')).toEqual({ to: `/mail/${BOX}`, label: 'Updates' });
  });

  it('leaves the mail view its own bar', () => {
    expect(contextParent('/', '/', 'Inbox')).toBeNull();
    expect(contextParent(`/mail/${BOX}`, '/', 'Inbox')).toBeNull();
  });

  it('titles the place indexes and every screen from the route table', () => {
    expect(placeIndexFor('/settings/')).toBe('settings');
    expect(placeIndexFor('/settings/rules')).toBeNull();
    expect(contextTitle('/admin')).toBe('Admin console');
    expect(contextTitle('/settings/rules')).toBe('Rules & sorting');
    expect(contextTitle('/settings/import')).toBe('Import');
    // PST-T-17.8: the bar collapses into the page's h1, which for the three Security screens is the
    // section's name, not the tab's.
    expect(contextTitle('/settings/security')).toBe('Security & devices');
    expect(contextTitle('/settings/security/sessions')).toBe('Security & devices');
    expect(contextTitle('/settings/security/devices')).toBe('Security & devices');
    expect(contextTitle('/senders/a%40b.example')).toBe('Sender');
  });
});
