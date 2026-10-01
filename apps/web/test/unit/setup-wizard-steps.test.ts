// PST-T-17.14 (PST-REQ-194; admin critique 2.9): the setup wizard's stepper — each step done, current
// or still to do, with the count — the DNS step's split into what to publish now and at go-live, the
// copyable record fields, and the test recipient's status as a dot and a word.
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DnsCheckRow, WizardView } from '../../src/api';
import { CopyField, LONG_VALUE } from '../../src/screens/setup/CopyField';
import { DnsChecklist } from '../../src/screens/setup/DnsChecklist';
import { recipientTone, recipientWord } from '../../src/screens/setup/recipient-state';
import { showLive, summaryOf, wizardDnsGroups } from '../../src/screens/setup/wizard-dns';
import { doneLabel, positionLabel, shownStep, stepItems, stepName, stepsDone } from '../../src/screens/setup/wizard-steps';
import { WizardSteps } from '../../src/screens/setup/WizardSteps';

// The design system's stylesheet cannot load under Node, so each component used here is a stand-in
// that keeps what these tests read: a field's width, a control's read-only state and name, a status
// dot's tone.
vi.mock('@d3cloud/ui', () => {
  type P = Record<string, unknown> & { children?: ReactNode };
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    Button: (p: P) => createElement('button', { type: 'button', className: str(p.className), 'aria-label': str(p['aria-label']) }, p.children),
    IconButton: (p: P) => createElement('button', { type: 'button', className: str(p.className), 'aria-label': str(p.label) }, p.icon as ReactNode),
    FormField: (p: P) =>
      createElement('div', { className: `ff ff--w-${str(p.width) ?? 'full'}` }, createElement('label', null, p.label as ReactNode), p.children, p.help as ReactNode),
    Input: (p: P) => createElement('input', { readOnly: p.readOnly === true, value: str(p.value), 'aria-label': str(p['aria-label']), className: str(p.className), onChange: () => undefined }),
    Textarea: (p: P) =>
      createElement('textarea', { readOnly: p.readOnly === true, rows: p.rows as number, value: str(p.value), 'aria-label': str(p['aria-label']), 'data-mono': p.mono === true ? 'true' : undefined, onChange: () => undefined }),
    StatusDot: (p: P) => createElement('span', { className: `sdot sdot--${str(p.tone) ?? 'neutral'}` }, p.children),
    Menu: (p: P) => createElement(Fragment, null, p.children),
    MenuTrigger: (p: P) => createElement(Fragment, null, p.children),
    MenuContent: (p: P) => createElement('div', { role: 'menu' }, p.children),
    MenuItem: (p: P) => createElement('div', { role: 'menuitem' }, p.children),
  };
});

const wizard = (over: Partial<WizardView>): WizardView => ({
  step: 'domain',
  completed: false,
  completedAt: null,
  domain: 'd3cloud.io',
  suggestedDomain: 'd3cloud.io',
  dkim: [],
  dnsAcknowledgedAt: null,
  mailbox: null,
  addresses: [],
  test: null,
  ...over,
});

const done = wizard({ step: 'done', completed: true, completedAt: '2026-10-01T10:00:00.000Z' });

describe('stepper state', () => {
  it('marks steps before the furthest reached as done, the one on screen as current, the rest to do', () => {
    const items = stepItems(wizard({ step: 'dns' }), 'dns');
    expect(items.map((i) => i.state)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(items.map((i) => i.reachable)).toEqual([true, true, true, false, false]);
    expect(items.map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
    expect(items.filter((i) => i.current)).toHaveLength(1);
  });

  it('a revisited step is current and keeps its ✓; the furthest step stays open but not done', () => {
    const items = stepItems(wizard({ step: 'dns' }), 'domain');
    expect(items[0]).toMatchObject({ step: 'domain', state: 'current', done: true, current: true });
    expect(items[2]).toMatchObject({ step: 'dns', state: 'todo', done: false, current: false, reachable: true });
  });

  it('on a fresh install only the first step is open, and nothing is done', () => {
    const items = stepItems(wizard({ step: 'domain' }), 'domain');
    expect(items.map((i) => i.state)).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(items.filter((i) => i.reachable).map((i) => i.step)).toEqual(['domain']);
  });

  it('once complete, every step is done and the test step (with its timeline) is the one on screen', () => {
    expect(shownStep('done')).toBe('test');
    const items = stepItems(done, 'done');
    expect(items.every((i) => i.done && i.reachable)).toBe(true);
    expect(items.map((i) => i.state)).toEqual(['done', 'done', 'done', 'done', 'current']);
  });

  it('counts what is done, and says where you are in one line', () => {
    expect(stepsDone(wizard({ step: 'domain' }))).toBe(0);
    expect(doneLabel(wizard({ step: 'domain' }))).toBe('0 of 5 done');
    expect(doneLabel(wizard({ step: 'dns' }))).toBe('2 of 5 done');
    expect(doneLabel(wizard({ step: 'test' }))).toBe('4 of 5 done');
    expect(doneLabel(done)).toBe('All 5 done');
    expect(positionLabel('dns')).toBe('Step 3 of 5 · DNS records');
    expect(positionLabel('done')).toBe('Step 5 of 5 · Test message');
  });

  it('names each step with its number, then its state in words (the circle is decoration)', () => {
    const items = stepItems(wizard({ step: 'dns' }), 'dns');
    expect(items.map(stepName)).toEqual(['1. Domain, done', '2. DKIM keys, done', '3. DNS records', '4. Mailbox, not reached yet', '5. Test message, not reached yet']);
  });
});

describe('the stepper as rendered', () => {
  const html = (view: WizardView, current: WizardView['step'], phone = false): string =>
    renderToStaticMarkup(createElement(WizardSteps, { view, current, phone, onPick: () => undefined }));

  it('is an ordered list in a "Setup steps" nav with the count, one aria-current step, ✓ on done steps', () => {
    const out = html(wizard({ step: 'dns' }), 'dns');
    expect(out).toContain('<nav aria-label="Setup steps"');
    expect(out).toContain('<ol class="pr-steps__list">');
    expect(out).toContain('2 of 5 done');
    expect(out.match(/aria-current="step"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="step"[^>]*aria-label="3\. DNS records"/);
    expect(out.match(/pr-steps__item--complete/g)).toHaveLength(2);
    // Two done circles draw a ✓ (an svg) instead of their number; the rest show their number.
    expect(out.match(/<span class="pr-steps__mark" aria-hidden="true"><svg/g)).toHaveLength(2);
    expect(out).toContain('<span class="pr-steps__mark" aria-hidden="true">3</span>');
  });

  it('marks steps not reached yet aria-disabled — never disabled, so their label is not dimmed', () => {
    const out = html(wizard({ step: 'dns' }), 'dns');
    expect(out.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(out).not.toMatch(/\sdisabled=""/);
  });

  it('on a phone is one line with the position, the count, and a five-segment bar', () => {
    const out = html(wizard({ step: 'dns' }), 'dns', true);
    expect(out).toContain('<nav aria-label="Setup steps" class="pr-steps pr-steps--phone"');
    expect(out).toContain('Step 3 of 5 · DNS records');
    expect(out).toContain('2 of 5 done');
    expect(out.match(/class="pr-steps__seg/g)).toHaveLength(5);
    expect(out.match(/pr-steps__seg--on/g)).toHaveLength(3);
    expect(out).not.toContain('<ol');
  });
});

const row = (over: Partial<DnsCheckRow>): DnsCheckRow => ({
  record: 'SPF',
  name: 'd3cloud.io',
  type: 'TXT',
  expected: 'v=spf1 ip4:203.0.113.7 -all',
  afterGoLive: false,
  note: null,
  live: [],
  status: 'pass',
  reason: 'Matches',
  ...over,
});

describe('the DNS step', () => {
  const rows = [
    row({ status: 'missing', reason: 'Nothing is published at this name yet.' }),
    row({ record: 'MX', type: 'MX', afterGoLive: true, status: 'pending', expected: '10 mx.d3cloud.io' }),
    row({ record: 'Role address', type: 'RCPT', name: 'postmaster@d3cloud.io', expected: null }),
    row({ record: 'DMARC', name: '_dmarc.d3cloud.io', status: 'fail', live: ['v=DMARC1; p=none'], reason: 'Policy is none' }),
  ];

  it('shows what to publish now, keeps go-live records apart, and leaves address checks to the DNS screen', () => {
    const groups = wizardDnsGroups(rows);
    expect(groups.now.map((r) => r.record)).toEqual(['SPF', 'DMARC']);
    expect(groups.goLive.map((r) => r.record)).toEqual(['MX']);
    expect(groups.addresses.map((r) => r.record)).toEqual(['Role address']);
  });

  it('brings a failing address check into the records to publish, counted in the summary', () => {
    const failing = row({ type: 'RCPT', record: 'postmaster@', status: 'fail' });
    const groups = wizardDnsGroups([...rows, failing]);
    expect(groups.now.map((r) => r.record)).toContain('postmaster@');
    expect(groups.addresses.map((r) => r.record)).not.toContain('postmaster@');
    expect(summaryOf(groups.now).fail).toBe(2);
  });

  it('summarises only the rows it shows', () => {
    expect(summaryOf(wizardDnsGroups(rows).now)).toEqual({ pass: 0, fail: 1, missing: 1, pending: 0, unknown: 0 });
  });

  it('shows the live answer only when it is not just the expected value again', () => {
    expect(showLive(row({}))).toBe(false);
    expect(showLive(rows[3] as DnsCheckRow)).toBe(true);
    expect(showLive(row({ status: 'missing', live: [] }))).toBe(false);
  });

  it('renders each record as a list item with a status dot and copyable name and value', () => {
    const out = renderToStaticMarkup(createElement(DnsChecklist, { rows: wizardDnsGroups(rows).now, label: 'Records to publish' }));
    expect(out).toContain('<ul class="pr-dnslist" aria-label="Records to publish">');
    expect(out.match(/<li class="pr-dnslist__item">/g)).toHaveLength(2);
    expect(out).toContain('<span class="sdot sdot--danger">Missing</span>');
    expect(out).toContain('<span class="sdot sdot--danger">Fail</span>');
    expect(out).toContain('aria-label="Copy expected SPF value for d3cloud.io"');
    expect(out).toContain('aria-label="Copy SPF record name for d3cloud.io"');
    expect(out).toContain('Published now');
    expect(out).toContain('v=DMARC1; p=none');
  });

  it('on a phone, its menu offers only the steps that can be opened', () => {
    const out = renderToStaticMarkup(createElement(WizardSteps, { view: wizard({ step: 'dns' }), current: 'dns', phone: true, onPick: () => undefined }));
    expect(out.match(/role="menuitem"/g)).toHaveLength(3);
    expect(out).not.toContain('Mailbox');
  });

  it('a record that already passes is one line: its name and why, with no fields to copy', () => {
    const out = renderToStaticMarkup(createElement(DnsChecklist, { rows: [row({})], label: 'Records to publish' }));
    expect(out).toContain('<span class="sdot sdot--neutral">Pass</span>');
    expect(out).not.toContain('<input');
    expect(out).toContain('Matches');
  });

  it('compact rows (go-live) leave out the fields', () => {
    const out = renderToStaticMarkup(createElement(DnsChecklist, { rows: wizardDnsGroups(rows).goLive, label: 'At go-live', compact: true }));
    expect(out).not.toContain('<input');
    expect(out).toContain('Pending');
  });
});

describe('copyable fields', () => {
  it('a name (one line) is a read-only input, a long value a two-line read-only textarea, each 24rem with a Copy button', () => {
    const short = renderToStaticMarkup(createElement(CopyField, { label: 'Name', value: 'rsa202609._domainkey.d3cloud.io', copyLabel: 'ed record name', oneLine: true }));
    expect(short).toContain('ff--w-lg');
    expect(short).toMatch(/<input[^>]*readOnly=""/);
    expect(short).toContain('aria-label="Copy ed record name"');
    const long = renderToStaticMarkup(createElement(CopyField, { label: 'Value', value: 'v=DKIM1; k=rsa; p='.padEnd(LONG_VALUE + 40, 'A'), copyLabel: 'rsa record value' }));
    expect(long).toMatch(/<textarea[^>]*readOnly=""[^>]*rows="2"|<textarea[^>]*rows="2"[^>]*readOnly=""/);
    expect(long).toContain('data-mono="true"');
  });
});

describe('the test recipient', () => {
  it('is neutral while it moves and once delivered, attention when deferred, danger when it failed', () => {
    expect(recipientTone('queued')).toBe('neutral');
    expect(recipientTone('attempting')).toBe('neutral');
    expect(recipientTone('delivered')).toBe('neutral');
    expect(recipientTone('deferred')).toBe('attention');
    expect(recipientTone('bounced')).toBe('danger');
    expect(recipientTone('cancelled')).toBe('danger');
    expect(recipientWord('delivered')).toBe('Delivered');
  });
});
