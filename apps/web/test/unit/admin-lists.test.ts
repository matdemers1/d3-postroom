// PST-T-17.2 (PST-REQ-194, PST-REQ-155): DNS & DKIM, Jobs, Suppressions and Sign-in sessions on the
// canvas. The pure parts (DNS grouping and labels, job counts and row actions, the suppression and
// session words) are tested directly; the layout rules — a card with a toolbar, StatusDot not Badge,
// RelativeTime not a local when(), a hidden actions header, no red in the row, no fr/minmax widths,
// DataList cards on a phone — are held by a source scan, so a later edit that undoes one fails here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// @d3cloud/ui's dist imports its own CSS, which Node cannot load; nothing here renders a library
// component (DnsName is plain markup), so every export is a stub that renders its children.
vi.mock('@d3cloud/ui', () => {
  const stub = (props: { children?: unknown }) => props.children ?? null;
  return new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : stub) });
});

import type { DnsCheckRow } from '../../src/api';
import { DnsName, dnsGroupOf, dnsLabel, dnsNameParts, dnsShowFrom, groupDnsRows, needsAttention } from '../../src/screens/AdminDns';
import { JOB_LIST_CAP, firstLine, jobAction, jobCounts, statusFrom, statusItems } from '../../src/screens/AdminJobs';
import { addressCount, hasBouncedMessage, replyOf, whyOf } from '../../src/screens/AdminSuppressions';
import { methodLabel, sessionCount } from '../../src/screens/AdminSessions';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');
const SCREENS = ['AdminDns', 'AdminJobs', 'AdminSuppressions', 'AdminSessions'] as const;

const row = (over: Partial<DnsCheckRow> & Pick<DnsCheckRow, 'record' | 'type'>): DnsCheckRow => ({
  name: 'd3cloud.io',
  expected: null,
  afterGoLive: false,
  note: null,
  live: [],
  status: 'pass',
  reason: '',
  ...over,
});

describe('DNS & DKIM: groups, order and labels', () => {
  it('puts every record kind in its group', () => {
    expect(dnsGroupOf({ record: 'MX', type: 'MX' })).toBe('mail');
    expect(dnsGroupOf({ record: 'PTR', type: 'PTR' })).toBe('mail');
    for (const r of ['SPF', 'DKIM', 'DMARC']) expect(dnsGroupOf({ record: r, type: 'TXT' })).toBe('auth');
    expect(dnsGroupOf({ record: 'MTA-STS', type: 'TXT' })).toBe('transport');
    expect(dnsGroupOf({ record: 'MTA-STS host', type: 'CNAME' })).toBe('transport');
    expect(dnsGroupOf({ record: 'TLS-RPT', type: 'TXT' })).toBe('transport');
    expect(dnsGroupOf({ record: 'SRV', type: 'SRV' })).toBe('discovery');
    expect(dnsGroupOf({ record: 'autoconfig', type: 'CNAME' })).toBe('discovery');
    expect(dnsGroupOf({ record: 'Role address', type: 'RCPT' })).toBe('mailboxes');
    expect(dnsGroupOf({ record: 'Report mailbox', type: 'RCPT' })).toBe('mailboxes');
  });

  it('orders groups as a zone is read, and sorts each worst first, keeping the server order on ties', () => {
    const rows = [
      row({ record: 'Role address', type: 'RCPT', name: 'postmaster@d3cloud.io' }),
      row({ record: 'DMARC', type: 'TXT', status: 'pass' }),
      row({ record: 'SPF', type: 'TXT', status: 'pending' }),
      row({ record: 'DKIM', type: 'TXT', status: 'missing' }),
      row({ record: 'MX', type: 'MX', status: 'fail' }),
      row({ record: 'SRV', type: 'SRV', name: '_imaps._tcp.d3cloud.io', status: 'pending' }),
      row({ record: 'SRV', type: 'SRV', name: '_caldavs._tcp.d3cloud.io', status: 'pending' }),
    ];
    const groups = groupDnsRows(rows);
    expect(groups.map((g) => g.title)).toEqual(['Mail flow', 'Authentication', 'Client discovery', 'Role mailboxes']);
    expect(groups[1]?.rows.map((r) => r.record)).toEqual(['DKIM', 'SPF', 'DMARC']);
    expect(groups[2]?.rows.map((r) => r.name)).toEqual(['_imaps._tcp.d3cloud.io', '_caldavs._tcp.d3cloud.io']);
    // Nothing is lost or duplicated.
    expect(groups.flatMap((g) => g.rows)).toHaveLength(rows.length);
  });

  it('says the type only when it adds something, and never the RCPT pseudo-type', () => {
    expect(dnsLabel({ record: 'MX', type: 'MX', name: 'd3cloud.io' })).toEqual({ label: 'MX', type: null });
    expect(dnsLabel({ record: 'PTR', type: 'PTR', name: 'x.in-addr.arpa' })).toEqual({ label: 'PTR', type: null });
    expect(dnsLabel({ record: 'SPF', type: 'TXT', name: 'd3cloud.io' })).toEqual({ label: 'SPF', type: 'TXT' });
    expect(dnsLabel({ record: 'SRV', type: 'SRV', name: '_imaps._tcp.d3cloud.io' })).toEqual({ label: 'IMAP', type: 'SRV' });
    expect(dnsLabel({ record: 'SRV', type: 'SRV', name: '_submissions._tcp.d3cloud.io' })).toEqual({ label: 'Submission', type: 'SRV' });
    expect(dnsLabel({ record: 'SRV', type: 'SRV', name: '_other._tcp.d3cloud.io' })).toEqual({ label: 'SRV', type: null });
    expect(dnsLabel({ record: 'Role address', type: 'RCPT', name: 'abuse@d3cloud.io' })).toEqual({ label: 'Role address', type: null });
  });

  it('breaks a DNS name only after a dot or an @', () => {
    expect(dnsNameParts('<selector>._domainkey.d3cloud.io')).toEqual(['<selector>.', '_domainkey.', 'd3cloud.', 'io']);
    expect(dnsNameParts('postmaster@d3cloud.io')).toEqual(['postmaster@', 'd3cloud.', 'io']);
    expect(dnsNameParts('localhost')).toEqual(['localhost']);
    expect(dnsNameParts('a.b.c').join('')).toBe('a.b.c');
    const html = renderToStaticMarkup(createElement(DnsName, { name: '_mta-sts.d3cloud.io' }));
    expect(html).toBe('<span class="pr-dns-name">_mta-sts.<wbr/>d3cloud.<wbr/>io</span>');
  });

  it('shows what needs attention by default, everything when nothing does, and ?show= wins', () => {
    expect(needsAttention({ status: 'pass' })).toBe(false);
    for (const s of ['fail', 'missing', 'pending', 'unknown'] as const) expect(needsAttention({ status: s })).toBe(true);
    expect(dnsShowFrom(null, 11)).toBe('attention');
    expect(dnsShowFrom(null, 0)).toBe('all');
    expect(dnsShowFrom('all', 11)).toBe('all');
    expect(dnsShowFrom('attention', 0)).toBe('attention');
    expect(dnsShowFrom('nonsense', 3)).toBe('attention');
  });
});

describe('Jobs: counts, the filter and the row action', () => {
  const jobs = (statuses: string[]) => statuses.map((status) => ({ status }));

  it('counts every state from the unfiltered list', () => {
    expect(jobCounts(jobs(['dead', 'pending', 'done', 'done']))).toEqual({ dead: 1, failed: 0, pending: 1, running: 0, done: 2 });
    expect(jobCounts([])).toEqual({ dead: 0, failed: 0, pending: 0, running: 0, done: 0 });
  });

  it('gives no counts when the list hit the API page size, rather than wrong ones', () => {
    expect(jobCounts(jobs(Array.from({ length: JOB_LIST_CAP }, () => 'done')))).toBeNull();
    const items = statusItems(jobs(Array.from({ length: JOB_LIST_CAP }, () => 'done')));
    expect(items.every((i) => i.count === undefined)).toBe(true);
  });

  it('offers All and the five states, each with its count (a SegmentedControl of counts, critique 2.6 #2)', () => {
    const items = statusItems(jobs(['dead', 'pending', 'done', 'done']));
    expect(items.map((i) => [i.value, i.label, i.count])).toEqual([
      ['', 'All', 4],
      ['dead', 'Dead', 1],
      ['failed', 'Failed', 0],
      ['pending', 'Pending', 1],
      ['running', 'Running', 0],
      ['done', 'Done', 2],
    ]);
    expect(statusItems(null).every((i) => i.count === undefined)).toBe(true);
  });

  it('reads ?status= and falls back to All for anything else (PST-REQ-198)', () => {
    expect(statusFrom(new URLSearchParams('status=dead'))).toBe('dead');
    expect(statusFrom(new URLSearchParams('status=bogus'))).toBe('');
    expect(statusFrom(new URLSearchParams(''))).toBe('');
  });

  it('shows Replay only on a failed job; a done one runs again from the menu; a live one has nothing', () => {
    expect(jobAction('dead')).toBe('replay');
    expect(jobAction('failed')).toBe('replay');
    expect(jobAction('done')).toBe('run-again');
    expect(jobAction('pending')).toBeNull();
    expect(jobAction('running')).toBeNull();
  });

  it('keeps the first non-empty line of an error', () => {
    expect(firstLine('Error: boom\n    at x (y.js:1)')).toBe('Error: boom');
    expect(firstLine('\n\n  simulated worker crash  \nmore')).toBe('simulated worker crash');
    expect(firstLine('')).toBe('');
  });
});

describe('Suppressions and Sign-in sessions: the words', () => {
  const entry = {
    id: '1',
    address: 'gone@example.org',
    reason: 'hard-bounce' as const,
    code: 550,
    enhanced: '5.1.1',
    text: 'No such user',
    bounceCount: 1,
    firstAt: '2026-10-01T00:00:00Z',
    lastAt: '2026-10-01T00:00:00Z',
    note: null,
    source: null,
  };

  it('says why in plain words, and the reply as the wire said it', () => {
    expect(whyOf(entry)).toBe('Hard bounce');
    expect(whyOf({ reason: 'manual' })).toBe('Added by an admin');
    expect(replyOf(entry)).toBe('550 5.1.1 No such user');
    expect(replyOf({ ...entry, reason: 'manual', note: 'a spam trap' })).toBe('a spam trap');
    expect(replyOf({ ...entry, code: null, enhanced: null, text: null })).toBe('—');
  });

  it('hides the Bounced message column when no row has one (critique 2.8 #4)', () => {
    expect(hasBouncedMessage([entry, entry])).toBe(false);
    expect(hasBouncedMessage([entry, { ...entry, source: { recipientId: 'r', outboundMessageId: 'o', subject: null } }])).toBe(true);
  });

  it('counts with the right noun', () => {
    expect(addressCount(1)).toBe('1 address');
    expect(addressCount(3)).toBe('3 addresses');
    expect(sessionCount(1)).toBe('1 session');
    expect(sessionCount(0)).toBe('0 sessions');
    expect(methodLabel('oidc')).toBe('D3 Auth');
    expect(methodLabel('password')).toBe('Password');
  });
});

describe('the four list screens on the canvas (source scan)', () => {
  it.each(SCREENS)('%s: a card with a toolbar, cards on a phone, lists.css', (screen) => {
    const src = read(`screens/${screen}.tsx`);
    expect(src).toContain('<Card className="pr-table-card">');
    expect(src).toContain('className="pr-table-toolbar"');
    expect(src).toContain('useMediaQuery(PHONE_QUERY)');
    expect(src).toMatch(/<DataList\b/);
    expect(src).toContain("import '../admin/lists.css';");
    expect(src).not.toContain('pr-admin-card');
  });

  it.each(SCREENS)('%s: status is a StatusDot, never a Badge; times are RelativeTime', (screen) => {
    const src = read(`screens/${screen}.tsx`);
    expect(src).not.toMatch(/<Badge\b/);
    expect(src).not.toMatch(/\bBadge\b/);
    expect(src).not.toMatch(/const when\b/);
    expect(src).not.toContain('toLocaleString(');
    if (screen !== 'AdminSessions' && screen !== 'AdminSuppressions') expect(src).toContain('<StatusDot');
    expect(src).toContain('RelativeTime');
  });

  it.each(SCREENS)('%s: widths in rem, % or auto; no red in the row; a hidden actions header', (screen) => {
    const src = read(`screens/${screen}.tsx`);
    for (const [, width] of src.matchAll(/width: '([^']+)'/g)) expect(width, `${screen} width ${width ?? ''}`).toMatch(/^(\d+(\.\d+)?(rem|%)|auto)$/);
    expect(src).not.toContain('minmax(');
    expect(src).not.toContain('danger-ghost');
    if (screen !== 'AdminDns') expect(src).toContain(`header: <span className="pr-sr-only">Actions</span>`);
    expect(src).not.toContain("header: 'Actions'");
  });

  it.each(['AdminJobs', 'AdminSuppressions'])('%s: the filter is one FilterBar row, not a stacked labelled field', (screen) => {
    const src = read(`screens/${screen}.tsx`);
    expect(src).toContain('<FilterBar');
    expect(src).not.toMatch(/<FormField label="(Status|Search|State|Domain)"/);
  });

  it('Jobs filters with a SegmentedControl; Suppressions with a SearchField; DNS triages with one', () => {
    expect(read('screens/AdminJobs.tsx')).toMatch(/<SegmentedControl aria-label="Status"/);
    expect(read('screens/AdminSuppressions.tsx')).toMatch(/<SearchField\s+aria-label="Search addresses"/);
    expect(read('screens/AdminDns.tsx')).toMatch(/<SegmentedControl\s+aria-label="Records shown"/);
  });

  it('Sign-in sessions has no Details disclosure in its rows, and keeps its step-up', () => {
    const src = read('screens/AdminSessions.tsx');
    expect(src).not.toContain('SessionDetails');
    expect(src).not.toContain('<details');
    expect(src).toContain('describeAgent(');
    expect(src).toContain('api\n      .stepUp(code)');
    expect(src).toContain('Verify and sign out');
  });

  it('Suppressions keeps its confirm-and-step-up modal for add and remove', () => {
    const src = read('screens/AdminSuppressions.tsx');
    expect(src).toContain('await api.stepUp(code);');
    expect(src).toContain("'Verify and remove'");
    expect(src).toContain("variant={pending?.kind === 'remove' ? 'danger' : 'primary'}");
  });

  it('lists.css uses tokens only: no hex, no shadow', () => {
    const css = read('admin/lists.css');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toContain('box-shadow');
    expect(css).not.toContain('--color-success');
  });
});
