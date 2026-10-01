import { type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  DataList,
  DataListRow,
  EmptyState,
  Page,
  PageHeader,
  SegmentedControl,
  Stat,
  StatGroup,
  StatusDot,
  type StatusDotTone,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { api, evidenceRowText, proposalSummary, type Deliverability, type DeliverabilitySource, type ProposalEvidenceDay, type ProposalResult } from '../api';
import { Loading, LoadFailed } from './states';
import { CardHead } from '../admin/health/CardHead';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import '../admin/admin.css';

/** The Range segments (admin critique 2.3 #2): five or fewer, so a SegmentedControl in the header. */
export const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: '3650', label: 'All time' },
] as const;
const DEFAULT_RANGE = '30';

/** ?days= as one of the ranges offered; anything else is the default. */
export function parseRange(params: URLSearchParams): string {
  const days = params.get('days') ?? '';
  return RANGES.some((r) => r.value === days) ? days : DEFAULT_RANGE;
}

const count = (n: number): string => n.toLocaleString();
const percent = (rate: number): string => `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`;
const rateOf = (pass: number, total: number): number => (total === 0 ? 0 : pass / total);
const dayLabel = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "1 reporter", "3 reporters" (admin critique 2.3 #6). */
export const plural = (n: number, one: string, other = `${one}s`): string => `${count(n)} ${n === 1 ? one : other}`;
/** A server sentence that starts lowercase ("no report covers …") starts with a capital here. */
export const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Every UTC day from the first reported day (or the range start, if later) to the range end, so a
 * quiet day shows as a gap rather than disappearing. At most the last 400 days.
 */
function daysIn(fromIso: string, toIso: string, firstReported: string | undefined): string[] {
  const from = new Date(fromIso);
  const fromDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const first = firstReported === undefined ? fromDay : Date.parse(`${firstReported}T00:00:00Z`);
  const end = new Date(toIso).getTime();
  const out: string[] = [];
  for (let t = Math.max(fromDay, first); t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out.slice(-400);
}

// D-016: a pass is the normal case, so it is drawn neutral; only a failure takes a hue.
// PST-REQ-154 (WCAG 1.4.1/1.4.11): pass and fail are only ~1.6:1 apart, so colour never carries the
// meaning alone — the fail segment is also hatched, separated by a 2px surface stroke, and its count
// is printed above the bar.
const PASS_FILL = { fill: 'var(--color-fg-muted)' };
const AXIS_TEXT = { fill: 'var(--color-fg-muted)', fontSize: 'var(--text-12)' };
const COUNT_TEXT = { fill: 'var(--color-fg)', fontSize: 'var(--text-12)', fontVariantNumeric: 'tabular-nums' } as const;
const AXIS_LINE = { stroke: 'var(--color-border)' };
const SEPARATOR_WIDTH = 2;

export interface DayBar {
  day: string;
  x: number;
  pass: number;
  fail: number;
  /** Top of the pass segment and its height; null when nothing passed. */
  passRect: { y: number; height: number } | null;
  /** Top of the fail segment and its height; null when nothing failed. */
  failRect: { y: number; height: number } | null;
  /** The printed failure count, centred above the whole bar; null on a day with no failures. */
  failLabel: { x: number; y: number; text: string } | null;
}

export interface BarLayout {
  left: number;
  top: number;
  plotW: number;
  plotH: number;
  /** The widest a bar may be, so one day in a wide chart is a bar, not a slab. */
  maxBarWidth?: number;
}

/** Per-day bar geometry and failure labels, pure so the chart's non-colour cues can be tested. */
export function dayBars(days: string[], byDay: Map<string, { pass: number; fail: number }>, layout: BarLayout): { bars: DayBar[]; max: number; barW: number } {
  const { left, top, plotW, plotH } = layout;
  const max = Math.max(1, ...days.map((d) => (byDay.get(d)?.pass ?? 0) + (byDay.get(d)?.fail ?? 0)));
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.min(layout.maxBarWidth ?? Number.POSITIVE_INFINITY, Math.max(1, slot * 0.7));
  const y = (v: number): number => top + plotH - (v / max) * plotH;
  const bars = days.map((day, i): DayBar => {
    const row = byDay.get(day);
    const pass = row?.pass ?? 0;
    const fail = row?.fail ?? 0;
    const x = left + i * slot + (slot - barW) / 2;
    return {
      day,
      x,
      pass,
      fail,
      passRect: pass > 0 ? { y: y(pass), height: top + plotH - y(pass) } : null,
      failRect: fail > 0 ? { y: y(pass + fail), height: y(pass) - y(pass + fail) } : null,
      failLabel: fail > 0 ? { x: x + barW / 2, y: y(pass + fail) - 4, text: count(fail) } : null,
    };
  });
  return { bars, max, barW };
}

/** Never narrower than this: below it the frame scrolls sideways instead of shrinking the labels. */
export const CHART_MIN_WIDTH = 280;
export const CHART_HEIGHT = 210;
export const MAX_BAR_WIDTH = 24;
/** Roughly how wide one "Sep 24" label needs to be, with air either side. */
const LABEL_SLOT = 64;

export interface ChartFrame {
  W: number;
  H: number;
  left: number;
  top: number;
  plotW: number;
  plotH: number;
  /** Label every n-th day (every day still gets a tick). */
  labelEvery: number;
}

/**
 * The chart drawn at its container's real pixel width (admin critique 2.3 #1), so text stays at the
 * token size (12px) at 1440 and at 390, and the plot is 166px tall either way. Pure, for the test.
 */
export function chartFrame(width: number, dayCount: number): ChartFrame {
  const W = Math.max(CHART_MIN_WIDTH, Math.floor(width));
  const H = CHART_HEIGHT;
  const left = 40;
  const right = 8;
  const top = 20;
  const bottom = 24;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const fit = Math.max(1, Math.floor(plotW / LABEL_SLOT));
  return { W, H, left, top, plotW, plotH, labelEvery: Math.max(1, Math.ceil(dayCount / fit)) };
}

/** The container's content width, kept up to date; `fallback` until it has been measured. */
function useWidth(fallback: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.clientWidth || fallback);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [fallback]);
  return [ref, width];
}

/**
 * Stacked bars, pass under fail, one per UTC day — drawn as inline SVG (no chart library, no
 * third-party script: PST-REQ-159). The figure's accessible name says what it shows and its
 * description carries the totals, so the chart is not the only place the numbers live.
 */
export function DayChart({ data }: { data: Deliverability }) {
  const titleId = useId();
  const descId = useId();
  // One pattern per chart instance, so two charts on a page never share (or clash on) an id.
  const hatchId = `${useId()}-fail-hatch`;
  const hatchFill = { fill: `url(#${hatchId})` };
  const failStyle = { ...hatchFill, stroke: 'var(--color-surface)', strokeWidth: SEPARATOR_WIDTH };
  const [frameRef, width] = useWidth(640);
  const byDay = new Map(data.dmarc.byDay.map((d) => [d.day, d]));
  const days = daysIn(data.range.from, data.range.to, data.dmarc.byDay[0]?.day);
  const { W, H, left, top, plotW, plotH, labelEvery } = chartFrame(width, days.length);
  const { bars, max, barW } = dayBars(days, byDay, { left, top, plotW, plotH, maxBarWidth: MAX_BAR_WIDTH });
  const { pass, fail } = data.dmarc.totals;
  const scrolls = W > Math.floor(width);
  const axisY = top + plotH;

  return (
    <figure data-chart="dmarc-by-day" className="pr-chart">
      <div
        ref={frameRef}
        className="pr-chart__frame"
        // Narrower than the chart's minimum, the frame scrolls: a keyboard user needs to reach it too.
        {...(scrolls ? { tabIndex: 0, role: 'group', 'aria-label': 'DMARC by day, scrolls sideways' } : {})}
      >
        <svg width={W} height={H} viewBox={`0 0 ${String(W)} ${String(H)}`} role="img" aria-labelledby={titleId} aria-describedby={descId}>
          <title id={titleId}>DMARC pass and fail by day</title>
          <desc id={descId}>{`${count(pass)} messages passed DMARC and ${count(fail)} failed across ${String(data.dmarc.byDay.length)} reported days.`}</desc>
          <defs>
            <pattern id={hatchId} data-pattern="fail-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--color-danger)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-surface)" strokeWidth="2" />
            </pattern>
          </defs>
          <line x1={left} x2={W - 8} y1={axisY} y2={axisY} style={AXIS_LINE} />
          <line x1={left} x2={left} y1={top} y2={axisY} style={AXIS_LINE} />
          <text x={left - 6} y={top + 4} textAnchor="end" style={AXIS_TEXT}>
            {count(max)}
          </text>
          <text x={left - 6} y={axisY} textAnchor="end" style={AXIS_TEXT}>
            0
          </text>
          {bars.map((bar, i) => (
            <g key={bar.day} data-day={bar.day}>
              <line data-tick x1={bar.x + barW / 2} x2={bar.x + barW / 2} y1={axisY} y2={axisY + 4} style={AXIS_LINE} />
              {bar.passRect !== null ? (
                <rect x={bar.x} width={barW} y={bar.passRect.y} height={bar.passRect.height} style={PASS_FILL}>
                  <title>{`${dayLabel(bar.day)}: ${count(bar.pass)} passed`}</title>
                </rect>
              ) : null}
              {bar.failRect !== null ? (
                <rect data-segment="fail" x={bar.x} width={barW} y={bar.failRect.y} height={bar.failRect.height} style={failStyle}>
                  <title>{`${dayLabel(bar.day)}: ${count(bar.fail)} failed`}</title>
                </rect>
              ) : null}
              {bar.failLabel !== null ? (
                <text data-fail-count x={bar.failLabel.x} y={bar.failLabel.y} textAnchor="middle" style={COUNT_TEXT}>
                  {bar.failLabel.text}
                </text>
              ) : null}
              {i % labelEvery === 0 ? (
                <text data-axis-label x={bar.x + barW / 2} y={H - 4} textAnchor="middle" style={AXIS_TEXT}>
                  {dayLabel(bar.day)}
                </text>
              ) : null}
            </g>
          ))}
        </svg>
      </div>
    </figure>
  );
}

/** The chart's key, in the card head (admin critique 2.3 #1): its own small hatch, the same tokens. */
export function ChartLegend() {
  const hatchId = `${useId()}-legend-hatch`;
  return (
    <span className="pr-chart-legend" data-chart-legend>
      <span className="pr-chart-legend__item">
        <svg width="12" height="12" aria-hidden="true">
          <rect width="12" height="12" style={PASS_FILL} />
        </svg>
        Passed
      </span>
      <span className="pr-chart-legend__item">
        <svg width="12" height="12" aria-hidden="true">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--color-danger)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-surface)" strokeWidth="2" />
            </pattern>
          </defs>
          <rect width="12" height="12" style={{ fill: `url(#${hatchId})` }} />
        </svg>
        Failed
      </span>
    </span>
  );
}

/** The failure count, tinted danger once there is one (PST-REQ-154); a zero stays neutral. */
export function FailedDmarcStat({ fail, quarantine, reject }: { fail: number; quarantine: number; reject: number }) {
  return (
    <Stat
      data-stat="failed"
      data-tone={fail > 0 ? 'danger' : undefined}
      label="Failed DMARC"
      value={fail > 0 ? <span style={{ color: 'var(--color-danger)' }}>{count(fail)}</span> : count(fail)}
      footnote={`${count(quarantine)} quarantined, ${count(reject)} rejected`}
    />
  );
}

/**
 * A pass rate's tone (D-016, admin critique 2.3 #5): a healthy rate is plain text; one that needs
 * you gets a dot — attention below 98%, danger below half. Never a pill.
 */
export function rateTone(rate: number): StatusDotTone | null {
  if (rate >= 0.98) return null;
  return rate >= 0.5 ? 'attention' : 'danger';
}

function RateText({ rate }: { rate: number }) {
  const tone = rateTone(rate);
  if (tone === null) return <>{percent(rate)}</>;
  return (
    <StatusDot tone={tone} size="sm">
      {percent(rate)}
    </StatusDot>
  );
}

/**
 * One domain's DMARC progression (PST-T-7.2, PST-REQ-123): why there is no proposal yet, or the
 * proposal — the exact TXT value to publish with a copy button, the 14 clean days as a meter, and
 * the evidence one tap away. Postroom never publishes DNS itself, so this is as far as it goes.
 */
function Progression({ result }: { result: ProposalResult }) {
  const [copied, setCopied] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const evidenceId = useId();
  const { proposal } = result;

  const copy = (value: string): void => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
      })
      .catch(() => {
        setCopied(false);
      });
  };

  return (
    <li data-proposal={result.domain} className="pr-progress">
      <div className="pr-progress__head">
        <span className="pr-admin-mono pr-progress__domain">{result.domain}</span>
        {result.eligible && proposal !== null ? (
          <StatusDot tone="attention" size="sm">
            Ready to tighten
          </StatusDot>
        ) : (
          <StatusDot tone="idle" size="sm">
            Not yet
          </StatusDot>
        )}
      </div>
      {result.eligible && proposal !== null ? (
        <>
          <p className="pr-progress__text">{proposalSummary(proposal)}</p>
          <span className="pr-progress__meter" role="img" aria-label={`${String(proposal.evidence.days.length)} of 14 clean days`}>
            {Array.from({ length: 14 }, (_, i) => (
              <span key={i} className={i < proposal.evidence.days.length ? 'pr-progress__seg pr-progress__seg--on' : 'pr-progress__seg'} />
            ))}
          </span>
          <code data-txt-value className="pr-dns-value pr-progress__txt">
            {proposal.txtValue}
          </code>
          <div className="pr-progress__actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                copy(proposal.txtValue);
              }}
            >
              {copied ? 'Copied' : 'Copy TXT record'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showEvidence}
              aria-controls={evidenceId}
              onClick={() => {
                setShowEvidence((v) => !v);
              }}
            >
              {showEvidence ? 'Hide evidence' : 'Show evidence'}
            </Button>
          </div>
          <div id={evidenceId} hidden={!showEvidence}>
            {showEvidence ? (
              <DataList aria-label={`14-day evidence for ${result.domain}`} className="pr-card-list">
                {proposal.evidence.days.map((d: ProposalEvidenceDay) => {
                  const text = evidenceRowText(d);
                  return (
                    <DataListRow
                      key={d.day}
                      title={<span className="pr-admin-mono">{d.day}</span>}
                      description={<span title={`${text.sources} · ${text.orgs}`}>{text.orgs === '' ? text.sources : `${text.orgs} · ${text.sources}`}</span>}
                      meta={plural(d.messages, 'message')}
                    />
                  );
                })}
              </DataList>
            ) : null}
          </div>
        </>
      ) : (
        <p data-proposal-reason className="pr-progress__text">
          {sentence(result.reason ?? 'Not eligible yet.')}
        </p>
      )}
    </li>
  );
}

type OrgRow = Deliverability['dmarc']['byOrg'][number];
type PolicyRow = Deliverability['tlsrpt']['byPolicy'][number];
type FailureRow = Deliverability['tlsrpt']['byFailureType'][number];

/** A list card: the head, then a table at desk width or DataList cards on a phone (PST-REQ-155). */
function ListCard<Row>({
  title,
  description,
  caption,
  rows,
  rowKey,
  columns,
  card,
  emptyText,
  phone,
}: {
  title: string;
  description?: string;
  caption: string;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  columns: TableColumn<Row>[];
  card: (row: Row) => { title: ReactNode; description?: ReactNode; meta?: ReactNode };
  emptyText: string;
  phone: boolean;
}) {
  const headId = useId();
  return (
    <Card as="section" aria-labelledby={headId} className="pr-table-card">
      <CardHead id={headId} title={title} description={description} />
      <ListBody caption={caption} rows={rows} rowKey={rowKey} columns={columns} card={card} emptyText={emptyText} phone={phone} />
    </Card>
  );
}

function ListBody<Row>({
  caption,
  rows,
  rowKey,
  columns,
  card,
  emptyText,
  phone,
}: {
  caption: string;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  columns: TableColumn<Row>[];
  card: (row: Row) => { title: ReactNode; description?: ReactNode; meta?: ReactNode };
  emptyText: string;
  phone: boolean;
}) {
  if (phone) {
    return (
      <DataList aria-label={caption} className="pr-card-list" empty={<EmptyState kind="empty" heading={emptyText} headingLevel={3} size="inline" />}>
        {rows.map((row) => {
          const c = card(row);
          return <DataListRow key={rowKey(row)} title={c.title} description={c.description} meta={c.meta} />;
        })}
      </DataList>
    );
  }
  return (
    <Table
      caption={caption}
      captionHidden
      columns={columns}
      rows={rows}
      rowKey={rowKey}
      className="pr-admin-table"
      empty={<EmptyState kind="empty" heading={emptyText} size="row" />}
    />
  );
}

const NUM = '6rem';

/**
 * PST-REQ-122: DMARC aggregate and TLS-RPT reports mailed to the report mailbox, charted — pass and
 * fail by day, every sending source with its pass rate, each reporting organization, and TLS
 * session success and failure by policy.
 *
 * PST-T-17.1 (PST-REQ-194/155, admin critique 2.3): the header holds the Range and Refresh; then
 * the stats, the chart beside the policy progression, and every table in a card — cards on a phone.
 */
export function AdminDeliverability() {
  const [params, setParams] = useSearchParams();
  const days = parseRange(params);
  const [data, setData] = useState<Deliverability | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [proposals, setProposals] = useState<ProposalResult[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);
  const chartHeadId = useId();
  const progressHeadId = useId();
  const tlsHeadId = useId();
  const failuresHeadId = useId();

  const load = useCallback(async (range: string) => {
    setRefreshing(true);
    try {
      setData(await api.adminDeliverability(Number(range)));
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const loadProposals = useCallback(async () => {
    try {
      setProposals((await api.adminDeliverabilityProposals()).proposals);
    } catch {
      setProposals(null);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [load, days]);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals]);

  const setDays = (value: string): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === DEFAULT_RANGE) next.delete('days');
        else next.set('days', value);
        return next;
      },
      { replace: true },
    );
  };

  const sourceColumns: TableColumn<DeliverabilitySource>[] = [
    {
      key: 'sourceIp',
      header: 'Source',
      width: 'auto',
      cell: (s) => (
        <span title={s.reverseDns ?? undefined}>
          <span className="pr-admin-mono">{s.sourceIp}</span>
          {s.reverseDns === null ? null : <span className="pr-muted"> {s.reverseDns}</span>}
        </span>
      ),
    },
    { key: 'orgs', header: 'Reported by', width: 'auto', cell: (s) => s.orgs.join(', ') },
    { key: 'messages', header: 'Messages', width: NUM, numeric: true, align: 'end', cell: (s) => count(s.messages) },
    { key: 'pass', header: 'Pass', width: NUM, numeric: true, align: 'end', cell: (s) => count(s.pass) },
    { key: 'fail', header: 'Fail', width: NUM, numeric: true, align: 'end', cell: (s) => count(s.fail) },
    { key: 'passRate', header: 'Pass rate', width: '6.5rem', numeric: true, align: 'end', cell: (s) => <RateText rate={s.passRate} /> },
  ];
  const orgColumns: TableColumn<OrgRow>[] = [
    { key: 'org', header: 'Reporter', width: 'auto', cell: (o) => o.org },
    { key: 'reports', header: 'Reports', width: NUM, numeric: true, align: 'end', cell: (o) => count(o.reports) },
    { key: 'messages', header: 'Messages', width: NUM, numeric: true, align: 'end', cell: (o) => count(o.messages) },
    { key: 'pass', header: 'Pass', width: NUM, numeric: true, align: 'end', cell: (o) => count(o.pass) },
    { key: 'fail', header: 'Fail', width: NUM, numeric: true, align: 'end', cell: (o) => count(o.fail) },
  ];
  const policyColumns: TableColumn<PolicyRow>[] = [
    { key: 'policyDomain', header: 'Policy domain', width: 'auto', cell: (p) => <span className="pr-admin-mono">{p.policyDomain}</span> },
    { key: 'policyType', header: 'Policy', width: '10rem', cell: (p) => p.policyType },
    { key: 'successful', header: 'Succeeded', width: NUM, numeric: true, align: 'end', cell: (p) => count(p.successful) },
    { key: 'failed', header: 'Failed', width: NUM, numeric: true, align: 'end', cell: (p) => count(p.failed) },
  ];
  const failureColumns: TableColumn<FailureRow>[] = [
    { key: 'resultType', header: 'Failure', width: 'auto', cell: (f) => <span className="pr-admin-mono">{f.resultType}</span> },
    { key: 'sessions', header: 'Sessions', width: NUM, numeric: true, align: 'end', cell: (f) => count(f.sessions) },
  ];

  const empty = data !== null && data.dmarc.totals.reports === 0 && data.tlsrpt.totals.reports === 0;
  const hasProgress = proposals !== null && proposals.length > 0;

  return (
    <Page>
      <PageHeader
        title="Deliverability"
        description="DMARC aggregate and TLS reports from the providers you send to: who sends as your domain, and whether it authenticates."
        actions={
          <div className="pr-header-actions">
            <SegmentedControl aria-label="Range" activationMode="manual" items={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={days} onValueChange={setDays} />
            <Button variant="secondary" loading={refreshing} onClick={() => void load(days)}>
              Refresh
            </Button>
          </div>
        }
      />

      {loadError !== null ? (
        <LoadFailed error={loadError} what="reports" onRetry={() => void load(days)} />
      ) : data === null ? (
        <Loading label="Loading reports" />
      ) : empty ? (
        <EmptyState kind="empty" heading="No reports yet" headingLevel={2}>
          {data.mailboxes.dmarc === null
            ? 'Reports appear here once the DMARC record’s rua address points at a Postroom mailbox.'
            : `Reports appear here once receivers mail them to ${data.mailboxes.dmarc} (the rua address in your DMARC record).`}
        </EmptyState>
      ) : (
        <>
          <Card as="section" aria-label="Summary" className="pr-admin-stats">
            <StatGroup>
              <Stat
                data-stat="pass-rate"
                label="DMARC pass rate"
                value={percent(rateOf(data.dmarc.totals.pass, data.dmarc.totals.messages))}
                footnote={`${count(data.dmarc.totals.pass)} of ${plural(data.dmarc.totals.messages, 'message')}`}
              />
              <FailedDmarcStat fail={data.dmarc.totals.fail} quarantine={data.dmarc.totals.dispositions.quarantine} reject={data.dmarc.totals.dispositions.reject} />
              <Stat data-stat="reports" label="Reports" value={count(data.dmarc.totals.reports)} footnote={`from ${plural(data.dmarc.byOrg.length, 'reporter')}`} />
              <Stat
                data-stat="tls"
                label="TLS sessions"
                value={count(data.tlsrpt.totals.successful + data.tlsrpt.totals.failed)}
                footnote={`${count(data.tlsrpt.totals.failed)} failed`}
              />
            </StatGroup>
          </Card>

          <div className={hasProgress ? 'pr-deliv-cols pr-deliv-cols--side' : 'pr-deliv-cols'}>
            <Card as="section" aria-labelledby={chartHeadId} className="pr-table-card">
              <CardHead id={chartHeadId} title="DMARC by day" description="Messages the reporters saw from your domain, by the UTC day each report begins." end={<ChartLegend />} />
              <div className="pr-card-body">
                <DayChart data={data} />
              </div>
            </Card>
            {hasProgress ? (
              <Card as="section" aria-labelledby={progressHeadId} className="pr-table-card">
                <CardHead
                  id={progressHeadId}
                  title="Policy progression"
                  description="14 consecutive UTC days of only aligned passes from authorized sources earn a proposal to tighten the policy. Postroom never publishes DNS itself."
                />
                <ul className="pr-progress-list" aria-label="DMARC progression proposals">
                  {proposals.map((p) => (
                    <Progression key={p.domain} result={p} />
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>

          <div className="pr-deliv-pair">
            <ListCard
              title="By source"
              description="Every IP address that sent mail as your domain. A low pass rate is a spoofer or a service you have not authorized."
              caption="DMARC results by sending source"
              rows={data.dmarc.bySource}
              rowKey={(s) => s.sourceIp}
              columns={sourceColumns}
              emptyText="No sources in this range"
              phone={phone}
              card={(s) => ({
                title: <span className="pr-admin-mono">{s.sourceIp}</span>,
                description: [s.reverseDns, s.orgs.length === 0 ? null : `Reported by ${s.orgs.join(', ')}`].filter((x) => x !== null).join(' · '),
                meta: (
                  <>
                    <span>
                      {count(s.pass)} pass · {count(s.fail)} fail
                    </span>
                    <RateText rate={s.passRate} />
                  </>
                ),
              })}
            />
            <ListCard
              title="By reporter"
              caption="DMARC results by reporting organization"
              rows={data.dmarc.byOrg}
              rowKey={(o) => o.org}
              columns={orgColumns}
              emptyText="No reports in this range"
              phone={phone}
              card={(o) => ({
                title: o.org,
                description: `${plural(o.reports, 'report')} · ${plural(o.messages, 'message')}`,
                meta: (
                  <span>
                    {count(o.pass)} pass · {count(o.fail)} fail
                  </span>
                ),
              })}
            />
          </div>

          <Card as="section" aria-labelledby={tlsHeadId} className="pr-table-card">
            <CardHead id={tlsHeadId} title="TLS reports" description="SMTP TLS reporting (RFC 8460): sessions senders opened to your MX, by policy, and why any failed." />
            <ListBody
              caption="TLS sessions by policy"
              rows={data.tlsrpt.byPolicy}
              rowKey={(p) => `${p.policyDomain}/${p.policyType}`}
              columns={policyColumns}
              emptyText="No TLS reports in this range"
              phone={phone}
              card={(p) => ({
                title: <span className="pr-admin-mono">{p.policyDomain}</span>,
                description: p.policyType,
                meta: (
                  <span>
                    {count(p.successful)} ok · {count(p.failed)} failed
                  </span>
                ),
              })}
            />
            {data.tlsrpt.byFailureType.length === 0 ? null : (
              <section aria-labelledby={failuresHeadId}>
                <div className="pr-card-head--sub">
                  <CardHead id={failuresHeadId} title="Failure reasons" level={3} />
                </div>
                <ListBody
                  caption="TLS failures by type"
                  rows={data.tlsrpt.byFailureType}
                  rowKey={(f) => f.resultType}
                  columns={failureColumns}
                  emptyText="No failures"
                  phone={phone}
                  card={(f) => ({ title: <span className="pr-admin-mono">{f.resultType}</span>, meta: plural(f.sessions, 'session') })}
                />
              </section>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
