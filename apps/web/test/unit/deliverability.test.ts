// PST-T-16.20 (PST-REQ-154, closes PST-DA-032): the DMARC-by-day chart reads without colour. The
// fail segment is hatched (an SVG <pattern>) and separated by a 2px surface stroke, each failing day
// prints its count above the bar, and the "Failed DMARC" stat is tinted danger above zero.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Deliverability } from '../../src/api';
import { DayChart, FailedDmarcStat, dayBars } from '../../src/screens/AdminDeliverability';

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
    expect(html).toContain('stroke="var(--color-surface)"');
    expect(html).toContain('fill="var(--color-danger)"');
    const fails = html.match(/<rect data-segment="fail"[^>]*>/g) ?? [];
    expect(fails).toHaveLength(2);
    for (const rect of fails) {
      expect(rect).toContain(`fill:url(#${id ?? ''})`);
      expect(rect).toContain('stroke:var(--color-surface)');
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
