// Fail-closed without a certificate: 587 serves, but with no STARTTLS there is no AUTH, and with no
// AUTH there is no MAIL — nothing can be submitted. 465 is not created at all. No database needed:
// nothing reaches it.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Db } from '@postroom/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';
import { SmtpTestClient, b64 } from '../integration/client.js';

describe('submission without a TLS certificate', () => {
  let listeners: SubmissionListeners;
  let port = 0;

  beforeAll(async () => {
    listeners = createSubmissionListeners({
      db: {} as Db,
      hostname: 'mail.d3cloud.io',
      maxSize: 1024,
      maxRecipients: 10,
      pepper: 'pepper',
      storage: () => {
        throw new Error('storage must not be reached');
      },
      tls: null,
    });
    listeners.submission.listen(0, '127.0.0.1');
    await once(listeners.submission, 'listening');
    port = (listeners.submission.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await listeners.close();
  });

  it('has no 465 listener, no STARTTLS, no AUTH, and refuses MAIL with 530', async () => {
    expect(listeners.submissions).toBeNull();
    const c = await SmtpTestClient.plain(port);
    expect((await c.next()).code).toBe(220);
    const ehlo = await c.send('EHLO client.test');
    expect(ehlo.lines).not.toContain('STARTTLS');
    expect(ehlo.lines.some((l) => l.startsWith('AUTH'))).toBe(false);
    expect((await c.send('STARTTLS')).code).toBe(502);
    expect((await c.send(`AUTH PLAIN ${b64('\0me@d3cloud.io\0pw')}`)).code).toBe(538);
    expect(await c.send('MAIL FROM:<me@d3cloud.io>')).toMatchObject({ code: 530, enhanced: '5.7.0' });
    c.close();
  });
});
