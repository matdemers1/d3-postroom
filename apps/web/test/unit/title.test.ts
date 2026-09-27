import { describe, expect, it } from 'vitest';
import { appTitle, titleForPath } from '../../src/title';

describe('web', () => {
  it('names the app', () => {
    expect(appTitle()).toBe('Postroom');
  });
});

describe('titleForPath (PST-DA-043)', () => {
  it('names the screen on every route in App.tsx', () => {
    expect(titleForPath('/')).toBe('Mail — Postroom');
    expect(titleForPath('/mail')).toBe('Mail — Postroom');
    expect(titleForPath('/mail/some-mailbox-id')).toBe('Mail — Postroom');
    expect(titleForPath('/setup')).toBe('Setup — Postroom');
    expect(titleForPath('/signin')).toBe('Sign in — Postroom');
    expect(titleForPath('/calendar')).toBe('Calendar — Postroom');
    expect(titleForPath('/contacts')).toBe('Contacts — Postroom');
    expect(titleForPath('/contacts/new')).toBe('Contacts — Postroom');
    expect(titleForPath('/senders/someone%40example.org')).toBe('Sender — Postroom');
    expect(titleForPath('/app-passwords')).toBe('App passwords — Postroom');
    expect(titleForPath('/account/aliases')).toBe('Masked aliases — Postroom');
    expect(titleForPath('/account/password')).toBe('Change password — Postroom');
    expect(titleForPath('/account/sessions')).toBe('Devices — Postroom');
    expect(titleForPath('/account/import')).toBe('Import mail — Postroom');
    expect(titleForPath('/account/device-setup')).toBe('Set up iPhone / Mac — Postroom');
    expect(titleForPath('/account/rules')).toBe('Rules — Postroom');
    expect(titleForPath('/account/templates')).toBe('Compose templates — Postroom');
    expect(titleForPath('/account/keys')).toBe('Keys — Postroom');
    expect(titleForPath('/admin/sessions')).toBe('Sessions — Postroom');
    expect(titleForPath('/admin/health')).toBe('Health — Postroom');
    expect(titleForPath('/admin/jobs')).toBe('Jobs — Postroom');
    expect(titleForPath('/admin/queue')).toBe('Outbound queue — Postroom');
    expect(titleForPath('/admin/suppressions')).toBe('Suppression list — Postroom');
    expect(titleForPath('/admin/deliverability')).toBe('Deliverability — Postroom');
    expect(titleForPath('/admin/smtp')).toBe('SMTP sessions — Postroom');
    expect(titleForPath('/admin/setup')).toBe('Setup wizard — Postroom');
    expect(titleForPath('/admin/dns')).toBe('DNS — Postroom');
  });
  it('falls back to the app name for an unmatched path', () => {
    expect(titleForPath('/not-a-real-route')).toBe('Postroom');
  });
});
