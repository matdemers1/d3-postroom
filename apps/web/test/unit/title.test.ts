import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../src/routes';
import { appTitle, titleForPath } from '../../src/title';

describe('web', () => {
  it('names the app', () => {
    expect(appTitle()).toBe('Postroom');
  });
});

describe('titleForPath (PST-DA-043, from the route table since PST-T-14.3)', () => {
  it('names the screen on every route', () => {
    expect(titleForPath('/')).toBe('Mail — Postroom');
    expect(titleForPath('/mail')).toBe('Mail — Postroom');
    expect(titleForPath('/mail/some-mailbox-id')).toBe('Mail — Postroom');
    expect(titleForPath('/setup')).toBe('Setup — Postroom');
    expect(titleForPath('/signin')).toBe('Sign in — Postroom');
    expect(titleForPath('/calendar')).toBe('Calendar — Postroom');
    expect(titleForPath('/contacts')).toBe('Contacts — Postroom');
    expect(titleForPath('/contacts/new')).toBe('Contacts — Postroom');
    expect(titleForPath('/contacts/book/card.vcf')).toBe('Contacts — Postroom');
    expect(titleForPath('/senders/someone%40example.org')).toBe('Sender — Postroom');
    expect(titleForPath('/settings/account')).toBe('Account — Postroom');
    expect(titleForPath('/settings/security')).toBe('Browser sessions — Postroom');
    expect(titleForPath('/settings/security/devices')).toBe('Devices — Postroom');
    expect(titleForPath('/settings/security/device-setup')).toBe('Set up iPhone / Mac — Postroom');
    expect(titleForPath('/settings/addresses')).toBe('Addresses — Postroom');
    expect(titleForPath('/settings/rules')).toBe('Rules — Postroom');
    expect(titleForPath('/settings/templates')).toBe('Templates — Postroom');
    expect(titleForPath('/settings/import')).toBe('Import & export — Postroom');
    expect(titleForPath('/settings/keys')).toBe('Encryption keys — Postroom');
    expect(titleForPath('/admin/sessions')).toBe('Sign-in sessions — Postroom');
    expect(titleForPath('/admin/health')).toBe('Health — Postroom');
    expect(titleForPath('/admin/jobs')).toBe('Jobs — Postroom');
    expect(titleForPath('/admin/queue')).toBe('Outbound queue — Postroom');
    expect(titleForPath('/admin/suppressions')).toBe('Suppressions — Postroom');
    expect(titleForPath('/admin/deliverability')).toBe('Deliverability — Postroom');
    expect(titleForPath('/admin/smtp')).toBe('Live SMTP — Postroom');
    expect(titleForPath('/admin/setup')).toBe('Setup — Postroom');
    expect(titleForPath('/admin/dns')).toBe('DNS & DKIM — Postroom');
  });

  it('every non-parameter route in the table has its own title', () => {
    for (const route of ROUTES) {
      if (route.path.includes(':') || route.path.includes('*')) continue;
      expect(titleForPath(route.path)).toBe(`${route.title} — Postroom`);
    }
  });

  it('falls back to the app name for an unmatched path', () => {
    expect(titleForPath('/not-a-real-route')).toBe('Postroom');
    expect(titleForPath('/account/password')).toBe('Postroom');
  });
});
