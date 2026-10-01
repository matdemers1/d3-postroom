// PST-T-16.20 (PST-REQ-154, closes PST-DA-032): the DMARC-by-day chart reads without colour. The
// fail segment is hatched (an SVG <pattern>) and separated by a 2px surface stroke, each failing day
// prints its count above the bar, and the "Failed DMARC" stat is tinted danger above zero.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Deliverability } from '../../src/api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHART_HEIGHT, CHART_MIN_WIDTH, DayChart, FailedDmarcStat, MAX_BAR_WIDTH, RANGES, chartFrame, dayBars, parseRange, plural, rateTone, sentence } from '../../src/screens/AdminDeliverability';

function data(byDay: { day: string; pass: number; fail: number }[]): Deliverability {
  const pass = byDay.reduce((n, d) => n + d.pass, 0);
  const fail = byDay.reduce((n, d) => n + d.fail, 0);
  return {
    range: { from: '2026-09-01T00:00:00Z', to: '2026-09-03T23:59:59Z' },
    dmarc: { totals: { pass, fail, messages: pass + fail, reports: 3, dispositions: { none: 0, quarantine: 0, reject: 0 } }, byDay, bySource: [], byOrg: [] },
    tlsrpt: { totals: { reports: 0, successful: 0, failed: 0 }, byPolicy: [], byFailureType: [] },
    mailboxes: { dmarc: null, tlsrpt: null },
  } as unknown as Deliverability;
}

// The library's stylesheet cannot load under node, so the two pieces this test touches are stubbed:
// Stat keeps its props as attributes (so the tint is observable) and renders its value.
vi.mock('@d3cloud/ui', () => ({
  Cluster: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  Stat: (props: { value: ReactNode; label: ReactNode; 'data-tone'?: string }) => createElement('div', { 'data-tone': props['data-tone'] }, props.label, props.value),
}));

const render = (d: Deliverability): string => renderToStaticMarkup(createElement(DayChart, { data: d }));

describe('DayChart without colour', () => {
  const html = render(
    data([
      { day: '2026-09-01', pass: 10, fail: 0 },
      { day: '2026-09-02', pass: 8, fail: 4 },
      { day: '2026-09-03', pass: 0, fail: 1234 },
    ]),
  );

  it('defines a hatch pattern from tokens and fills every fail segment with it', () => {
    const id = /<pattern id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    // D3 UI 1.5: the chart sits on a card, so the separator is the card's own surface.
    expect(html).toContain('stroke="var(--color-surface-card)"');
    expect(html).toContain('fill="var(--color-danger)"');
    const fails = html.match(/<rect data-segment="fail"[^>]*>/g) ?? [];
    expect(fails).toHaveLength(2);
    for (const rect of fails) {
      expect(rect).toContain(`fill:url(#${id ?? ''})`);
      expect(rect).toContain('stroke:var(--color-surface-card)');
      expect(rect).toContain('stroke-width:2');
    }
  });

  it('prints the failure count as visible text on each failing day, and none on a clean day', () => {
    const labels = [...html.matchAll(/<text data-fail-count[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(labels).toEqual(['4', (1234).toLocaleString()]);
    const clean = /<g data-day="2026-09-01">.*?<\/g>/.exec(html)?.[0] ?? '';
    expect(clean).not.toContain('data-fail-count');
  });

  it('gives each chart instance its own pattern id', () => {
    const other = renderToStaticMarkup(
      createElement('div', null, createElement(DayChart, { data: data([{ day: '2026-09-01', pass: 1, fail: 1 }]) }), createElement(DayChart, { data: data([{ day: '2026-09-01', pass: 1, fail: 1 }]) })),
    );
    const ids = [...other.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('dayBars', () => {
  it('places the label above the top of the whole bar, stacked pass under fail', () => {
    const layout = { left: 0, top: 20, plotW: 100, plotH: 100 };
    const { bars } = dayBars(['a', 'b'], new Map([['a', { pass: 6, fail: 4 }], ['b', { pass: 5, fail: 0 }]]), layout);
    const a = bars[0];
    expect(a?.failRect).toEqual({ y: 20, height: 40 });
    expect(a?.passRect).toEqual({ y: 60, height: 60 });
    expect(a?.failLabel?.y).toBe(16);
    expect(bars[1]?.failLabel).toBeNull();
  });
});

describe('FailedDmarcStat', () => {
  it('is tinted danger when there are failures', () => {
    const html = renderToStaticMarkup(createElement(FailedDmarcStat, { fail: 3, quarantine: 1, reject: 0 }));
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('color:var(--color-danger)');
  });

  it('is not tinted at zero', () => {
    const html = renderToStaticMarkup(createElement(FailedDmarcStat, { fail: 0, quarantine: 0, reject: 0 }));
    expect(html).not.toContain('data-tone');
    expect(html).not.toContain('--color-danger');
  });
});

describe('the chart at its real width (PST-T-17.1, admin critique 2.3 #1)', () => {
  it('is drawn in pixels, never under 280px wide, with a 166px plot', () => {
    expect(chartFrame(1100, 30)).toMatchObject({ W: 1100, H: CHART_HEIGHT });
    expect(chartFrame(1100, 30).plotH).toBeGreaterThanOrEqual(160);
    expect(chartFrame(1100, 30).plotH).toBeLessThanOrEqual(200);
    expect(chartFrame(200, 7).W).toBe(CHART_MIN_WIDTH);
    expect(CHART_MIN_WIDTH).toBe(280);
  });

  it('labels every n-th day so labels never crowd: about one per 64px', () => {
    expect(chartFrame(1100, 7).labelEvery).toBe(1);
    const narrow = chartFrame(320, 30);
    expect(Math.ceil(30 / narrow.labelEvery) * 64).toBeLessThanOrEqual(narrow.plotW + 64);
    expect(narrow.labelEvery).toBeGreaterThan(1);
  });

  it('caps a bar at 24px however wide the chart', () => {
    const { barW } = dayBars(['a'], new Map([['a', { pass: 1, fail: 0 }]]), { left: 0, top: 0, plotW: 1000, plotH: 100, maxBarWidth: MAX_BAR_WIDTH });
    expect(barW).toBe(24);
  });

  it('renders the svg at pixel size with 12px axis text and a tick for every day', () => {
    const html = render(
      data([
        { day: '2026-09-01', pass: 10, fail: 0 },
        { day: '2026-09-03', pass: 2, fail: 1 },
      ]),
    );
    expect(html).toMatch(/<svg width="640" height="210" viewBox="0 0 640 210"/);
    expect(html).not.toContain('width="100%"');
    expect(html.match(/<line data-tick/g)).toHaveLength(3);
    expect(html).toContain('font-size:var(--text-12)');
  });
});

describe('Deliverability words and tones (PST-T-17.1, admin critique 2.3)', () => {
  it('a healthy rate is plain text; a low one takes a dot (warning, D-086 — not the link violet), never a pill', () => {
    expect(rateTone(1)).toBeNull();
    expect(rateTone(0.98)).toBeNull();
    expect(rateTone(0.94)).toBe('warning');
    expect(rateTone(0)).toBe('danger');
  });

  it('pluralises, and capitalises a server sentence', () => {
    expect(plural(1, 'reporter')).toBe('1 reporter');
    expect(plural(3, 'reporter')).toBe('3 reporters');
    expect(sentence('no report covers 2026-09-17 (UTC)')).toBe('No report covers 2026-09-17 (UTC)');
  });

  it('the Range is five segments read from ?days=, defaulting to 30', () => {
    expect(RANGES.map((r) => r.label)).toEqual(['7 days', '30 days', '90 days', '1 year', 'All time']);
    expect(parseRange(new URLSearchParams('days=3650'))).toBe('3650');
    expect(parseRange(new URLSearchParams('days=12'))).toBe('30');
    expect(parseRange(new URLSearchParams(''))).toBe('30');
  });

  it('the screen has the Range in the header, no Badge, no FormField, and every table in a card', () => {
    const src = readFileSync(join(__dirname, '../../src/screens/AdminDeliverability.tsx'), 'utf8');
    expect(src).toMatch(/actions=\{\s*<div className="pr-header-actions">\s*<SegmentedControl aria-label="Range"/);
    expect(src).not.toMatch(/<Badge\b/);
    expect(src).not.toMatch(/<FormField\b/);
    expect(src).toContain('className="pr-table-card"');
    expect(src).toContain("from ${plural(data.dmarc.byOrg.length, 'reporter')}");
  });
});

describe('Deliverability layout (PST-T-17.1 verifier)', () => {
  const src = readFileSync(join(__dirname, '../../src/screens/AdminDeliverability.tsx'), 'utf8');
  const css = readFileSync(join(__dirname, '../../src/admin/admin.css'), 'utf8');

  it('draws a pass in --color-fg-faint (6.0:1 on the dark card, 7.4:1 light: still ≥3:1), so the failure is what reads first', () => {
    const html = render(data([{ day: '2026-09-01', pass: 3, fail: 0 }]));
    const passRect = /<rect [^>]*style="fill:([^"]+)"><title>[^<]*passed<\/title>/.exec(html)?.[1];
    expect(passRect).toBe('var(--color-fg-faint)');
  });

  it('puts By source and By reporter side by side from 1200px', () => {
    expect(css).toMatch(/@media \(min-width: 1200px\) \{\s*\.pr-deliv-pair \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
  });

  it('both cards fit side by side: By source has no Messages column (it is Pass + Fail) and its reporters sit under the address', () => {
    expect(src).not.toMatch(/key: 'messages', header: 'Messages', width: NUM, numeric: true, align: 'end', cell: \(s\)/);
    expect(src).not.toMatch(/key: 'orgs', header: 'Reported by'/);
    expect(src).toContain('pr-cell-stack');
  });

  it('shows the policy progression (the TXT value to publish) in the empty and load-error states too, above them', () => {
    expect(src).toMatch(/loadError !== null \? \(\s*<>\s*\{progressCard\}\s*<LoadFailed/);
    expect(src).toMatch(/empty \? \(\s*<>\s*\{progressCard\}\s*<EmptyState/);
  });

  it('on a phone Refresh goes to the context bar (X11)', () => {
    expect(src).toContain('useContextBarAction(');
  });
});
