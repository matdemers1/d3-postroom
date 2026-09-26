// PST-T-6.1, PST-REQ-114/115: the Inspect drawer shows every section for a fixture, and learn mode
// adds rfc-editor links (and only then). Rendered to a string with react-dom/server — the drawer
// chrome (Modal, focus, axe, 390 px) is e2e/tests/inspect.spec.ts.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MessageInspect } from '../../src/api';
import { buildCommands } from '../../src/mail/commands';
import { delayText, INSPECT_SECTIONS, InspectSections, resultTone, tlsLabel } from '../../src/mail/InspectDrawer';
import { onInspectRequest, resolveKey } from '../../src/mail/keys';

// @d3cloud/ui ships a CSS import Node cannot load; plain stand-ins keep this a pure markup test.
vi.mock('@d3cloud/ui', () => {
  const box = (tag: string) => (props: { children?: ReactNode; title?: ReactNode }) => createElement(tag, null, props.title ?? null, props.children);
  return { Alert: box('div'), Badge: box('span'), Button: box('button'), Checkbox: box('span'), Cluster: box('div'), Modal: box('div'), ModalClose: box('span'), Skeleton: box('span'), Stack: box('div') };
});

const FIXTURE: MessageInspect = {
  id: '22222222-2222-4222-8222-222222222222',
  auth: {
    source: 'verdict',
    spf: { result: 'pass', domain: 'bounce.example.org', scope: 'mfrom', mechanism: 'ip4:192.0.2.0/24', alignment: { aligned: true, mode: 'relaxed' }, reasons: ['matched ip4:192.0.2.0/24'] },
    dkim: [{ result: 'pass', domain: 'example.org', selector: 's1', algorithm: 'rsa-sha256', testing: false, alignment: { aligned: true, mode: 'relaxed' }, reasons: ['signature verified'] }],
    dmarc: { result: 'pass', disposition: 'none', fromDomain: 'example.org', policy: 'reject', policySource: 'p', recordDomain: 'example.org', reasons: ['DKIM pass for d=example.org, relaxedly aligned with example.org'] },
    arc: { result: 'none', instances: 0, sealerDomains: [], reasons: ['no ARC sets'] },
    arcOverride: null,
    dnsbl: { listed: false, zone: 'zen.spamhaus.org', reason: null },
    authenticationResults: ['mx.d3cloud.io; dmarc=pass header.from=example.org'],
  },
  received: [
    { raw: 'r1', from: 'origin.example.org', fromRdns: null, fromIp: '198.51.100.7', by: 'mail-out.example.org', via: null, with: 'ESMTP', id: 'a', for: null, tls: { encrypted: true, version: 'TLS1.2', cipher: 'ECDHE-RSA-AES256-GCM-SHA384' }, timestamp: '2026-09-24T10:00:00.000Z', delaySeconds: null, ours: false },
    { raw: 'r2', from: 'relay.example.net', fromRdns: 'relay.example.net', fromIp: '203.0.113.5', by: 'mx.d3cloud.io', via: null, with: 'SMTP', id: 'b', for: 'me@d3cloud.io', tls: { encrypted: false, version: null, cipher: null }, timestamp: '2026-09-24T10:00:07.000Z', delaySeconds: 7, ours: true },
  ],
  receipt: {
    sessionId: 's', clientIp: '203.0.113.5', proxied: true, helo: 'relay.example.net', rdns: 'relay.example.net', tls: 'STARTTLS', sessionStartedAt: '2026-09-24T10:00:06.000Z',
    receivedAt: '2026-09-24T10:00:07.000Z', envelopeFrom: 'bounce@bounce.example.org', disposition: 'accept', dispositionReason: 'DMARC pass', smtpReply: '250 2.0.0 Queued as tx-1', decision: { action: 'accept', rule: 'dmarc-pass', reasons: ['DMARC pass'] },
  },
  bucket: { bucket: 'newsletters', reasons: ['bulk: List-Unsubscribe present', 'filed to Newsletters'], scores: [{ name: 'bucket:newsletters', value: 1 }, { name: 'bayes:newsletters', value: 0.87 }] },
  spam: {
    signals: [{ name: 'bulk', value: 1 }],
    bayes: { probabilities: [{ bucket: 'newsletters', probability: 0.87 }], trainingDocs: 42, topTokens: ['h:list-unsubscribe', 'weekly'], reason: 'bayes: newsletters 0.87' },
    attachments: [],
  },
  trackers: { html: true, remoteImages: 2, trackersBlocked: 1, linksCleaned: 3 },
  mdn: { requested: true, to: ['news@example.org'], header: 'News <news@example.org>', options: null, returnPath: '<news@example.org>', returnPathMatches: true, sent: false },
  headers: [
    { name: 'Received', value: 'from relay.example.net …' },
    { name: 'DKIM-Signature', value: 'v=1; d=example.org' },
    { name: 'Subject', value: 'Weekly digest' },
    { name: 'X-Mailer', value: 'Thing 1.0' },
  ],
  raw: { url: '/api/messages/22222222-2222-4222-8222-222222222222/raw', size: 2048 },
};

const render = (learn: boolean, data: MessageInspect = FIXTURE): string => renderToStaticMarkup(createElement(InspectSections, { data, learn }));

/** Each section's markup, by heading. */
function sections(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<section[^>]*data-section="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.set(m[1] ?? '', m[2] ?? '');
  return out;
}

describe('InspectSections (PST-REQ-114)', () => {
  it('shows every section, in order, each with content, for the fixture', () => {
    const html = render(false);
    const found = sections(html);
    expect([...found.keys()]).toEqual([...INSPECT_SECTIONS]);
    const text = (name: string) => (found.get(name) ?? '').replace(/<[^>]+>/g, ' ');
    expect(text('Authentication')).toContain('bounce.example.org');
    expect(text('Authentication')).toContain('s=');
    expect(text('Authentication')).toContain('aligned with the From domain');
    expect(text('Authentication')).toContain('zen.spamhaus.org');
    expect(text('Received path')).toContain('Encrypted · TLS1.2');
    expect(text('Received path')).toContain('Not encrypted');
    expect(text('Received path')).toContain('This server');
    expect(text('Received path')).toContain('+7 s after the previous hop');
    expect(text('Received path')).toContain('250 2.0.0 Queued as tx-1');
    expect(text('Why this bucket')).toContain('filed to Newsletters');
    expect(text('Spam score breakdown')).toContain('h:list-unsubscribe');
    expect(text('Spam score breakdown')).toContain('trained on 42 messages');
    expect(text('Trackers removed')).toContain('1 tracking pixel removed');
    expect(text('Trackers removed')).toContain('3 links');
    expect(text('MDN request')).toContain('news@example.org');
    expect(text('MDN request')).toContain('No receipt has been sent');
    expect(text('Headers')).toContain('X-Mailer');
    expect(text('Raw source')).toContain('Download raw');
    expect(found.get('Raw source')).toContain(`href="${FIXTURE.raw.url}"`);
  });

  it('says so plainly when a section has nothing (a Sent copy)', () => {
    const empty: MessageInspect = {
      ...FIXTURE,
      auth: { source: 'none', spf: null, dkim: [], dmarc: null, arc: null, arcOverride: null, dnsbl: null, authenticationResults: [] },
      received: [],
      receipt: null,
      bucket: null,
      spam: { signals: [], bayes: null, attachments: [] },
      trackers: { html: false, remoteImages: 0, trackersBlocked: 0, linksCleaned: 0 },
      mdn: { requested: false, to: [], header: null, options: null, returnPath: null, returnPathMatches: null, sent: false },
    };
    const found = sections(render(false, empty));
    expect([...found.keys()]).toEqual([...INSPECT_SECTIONS]);
    for (const [name, body] of found) expect(body.replace(/<[^>]+>/g, '').trim().length, name).toBeGreaterThan(name.length);
    expect(found.get('Authentication')).toContain('No authentication verdicts');
    expect(found.get('MDN request')).toContain('did not ask');
  });

  it('has no RFC links with learn mode off', () => {
    expect(render(false)).not.toContain('rfc-editor.org');
  });
});

describe('learn mode links (PST-REQ-115)', () => {
  const html = render(true);
  const hrefs = [...html.matchAll(/href="(https:\/\/www\.rfc-editor\.org[^"]*)"/g)].map((m) => m[1] ?? '');

  it('links headers, reply codes and verdicts, every one to an rfc-editor section anchor', () => {
    expect(hrefs.length).toBeGreaterThan(10);
    for (const h of hrefs) expect(h).toMatch(/^https:\/\/www\.rfc-editor\.org\/rfc\/rfc\d+#section-\d+(?:\.\d+)*$/);
    for (const expected of ['rfc5321#section-4.4', 'rfc6376#section-3.5', 'rfc5322#section-3.6.5', 'rfc7208#section-2.6.3', 'rfc7489#section-6.6', 'rfc7489#section-3.1', 'rfc8617#section-4.4', 'rfc5782#section-2.1', 'rfc5321#section-4.2.3', 'rfc3463#section-3.1', 'rfc8098#section-2.1', 'rfc8601#section-2.2', 'rfc3848#section-1']) {
      expect(hrefs.some((h) => h.endsWith(expected)), expected).toBe(true);
    }
  });

  it('opens them in a new tab with no opener or referrer — plain links, never fetched', () => {
    const anchors = [...html.matchAll(/<a [^>]*href="https:\/\/www\.rfc-editor\.org[^>]*>/g)].map((m) => m[0]);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it('leaves an unregistered header unlinked', () => {
    const row = /<tr><th scope="row">X-Mailer([\s\S]*?)<\/th>/.exec(html)?.[1] ?? '';
    expect(row).not.toContain('rfc-editor');
  });
});

describe('small helpers', () => {
  it('tones, delays and TLS labels', () => {
    expect(resultTone('pass')).toBe('neutral');
    expect(resultTone('fail')).toBe('danger');
    expect(resultTone('softfail')).toBe('attention');
    expect(delayText(null)).toBeNull();
    expect(delayText(5)).toBe('+5 s');
    expect(delayText(-3)).toBe('−3 s');
    expect(delayText(120)).toBe('+2 min');
    expect(delayText(5400)).toBe('+1.5 h');
    expect(tlsLabel({ encrypted: true, version: null, cipher: null })).toBe('Encrypted');
  });
});

describe('opening it (keys.ts, commands.ts)', () => {
  const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, editable: false, activatable: false });
  it('`i` inspects; `g` then `i` still goes to the inbox', () => {
    expect(resolveKey(key('i'), null).action).toBe('inspect');
    expect(resolveKey(key('i'), 'g').action).toBe('goInbox');
  });
  it('the palette command reaches the open drawer', () => {
    let opened = 0;
    const off = onInspectRequest(() => {
      opened++;
    });
    const performed: string[] = [];
    const commands = buildCommands({ mailboxes: null, target: null, perform: (a) => performed.push(a), move: () => undefined, navigate: () => undefined });
    const cmd = commands.find((c) => c.id === 'action:inspect');
    expect(cmd?.label).toBe('Inspect the open message');
    cmd?.run();
    expect(opened).toBe(1);
    expect(performed).toEqual([]);
    off();
    cmd?.run();
    expect(opened).toBe(1);
  });
});
