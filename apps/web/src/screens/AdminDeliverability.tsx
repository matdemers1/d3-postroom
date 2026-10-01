import { useCallback, useEffect, useId, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardTitle,
  Cluster,
  EmptyState,
  FormField,
  Grid,
  Page,
  PageHeader,
  Section,
  Select,
  Stack,
  Stat,
  StatGroup,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { api, evidenceRowText, proposalSummary, type Deliverability, type DeliverabilitySource, type ProposalEvidenceDay, type ProposalResult } from '../api';
import { Loading, LoadFailed } from './states';
import '../admin/admin.css';

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
  { value: '3650', label: 'All time' },
];

const count = (n: number): string => n.toLocaleString();
const percent = (rate: number): string => `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`;
const rateOf = (pass: number, total: number): number => (total === 0 ? 0 : pass / total);
const dayLabel = (iso: string): string => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

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
}

/** Per-day bar geometry and failure labels, pure so the chart's non-colour cues can be tested. */
export function dayBars(days: string[], byDay: Map<string, { pass: number; fail: number }>, layout: BarLayout): { bars: DayBar[]; max: number; barW: number } {
  const { left, top, plotW, plotH } = layout;
  const max = Math.max(1, ...days.map((d) => (byDay.get(d)?.pass ?? 0) + (byDay.get(d)?.fail ?? 0)));
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(1, slot * 0.7);
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
  const byDay = new Map(data.dmarc.byDay.map((d) => [d.day, d]));
  const days = daysIn(data.range.from, data.range.to, data.dmarc.byDay[0]?.day);
  const W = 640;
  const H = 220;
  const left = 44;
  const bottom = 24;
  const top = 20;
  const plotW = W - left - 8;
  const plotH = H - top - bottom;
  const { bars, max, barW } = dayBars(days, byDay, { left, top, plotW, plotH });
  const labelEvery = Math.ceil(days.length / 6);
  const { pass, fail } = data.dmarc.totals;

  return (
    <figure data-chart="dmarc-by-day">
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} width="100%" role="img" aria-labelledby={titleId} aria-describedby={descId} preserveAspectRatio="xMidYMid meet">
        <title id={titleId}>DMARC pass and fail by day</title>
        <desc id={descId}>{`${count(pass)} messages passed DMARC and ${count(fail)} failed across ${String(data.dmarc.byDay.length)} reported days.`}</desc>
        <defs>
          <pattern id={hatchId} data-pattern="fail-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--color-danger)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-surface)" strokeWidth="2" />
          </pattern>
        </defs>
        <line x1={left} x2={W - 8} y1={top + plotH} y2={top + plotH} style={AXIS_LINE} />
        <line x1={left} x2={left} y1={top} y2={top + plotH} style={AXIS_LINE} />
        <text x={left - 6} y={top + 10} textAnchor="end" style={AXIS_TEXT}>
          {count(max)}
        </text>
        <text x={left - 6} y={top + plotH} textAnchor="end" style={AXIS_TEXT}>
          0
        </text>
        {bars.map((bar, i) => (
          <g key={bar.day} data-day={bar.day}>
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
              <text x={bar.x + barW / 2} y={H - 6} textAnchor="middle" style={AXIS_TEXT}>
                {dayLabel(bar.day)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <figcaption>
        <Cluster gap="12">
          <span>
            <svg width="12" height="12" aria-hidden="true">
              <rect width="12" height="12" style={PASS_FILL} />
            </svg>{' '}
            Passed DMARC
          </span>
          <span>
            <svg width="12" height="12" aria-hidden="true">
              <rect width="12" height="12" style={hatchFill} />
            </svg>{' '}
            Failed DMARC
          </span>
        </Cluster>
      </figcaption>
    </figure>
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

/** A healthy pass rate is just a number; only one that needs you is badged (D-016). */
function rateCell(rate: number) {
  if (rate >= 0.98) return percent(rate);
  if (rate >= 0.5) return <Badge tone="attention">{percent(rate)}</Badge>;
  return <Badge tone="danger">{percent(rate)}</Badge>;
}

/**
 * One domain's DMARC progression proposal (PST-T-7.2, PST-REQ-123): the 14-day evidence and the
 * exact TXT value to publish, with a copy button — Postroom never publishes DNS itself, so this is
 * as far as it goes.
 */
function ProposalCard({ result }: { result: ProposalResult }) {
  const [copied, setCopied] = useState(false);
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

  const evidenceColumns: TableColumn<ProposalEvidenceDay>[] = [
    { key: 'day', header: 'Day (UTC)', cell: (d) => <span className="pr-mono">{d.day}</span> },
    { key: 'reports', header: 'Reports', numeric: true, cell: (d) => count(d.reports) },
    { key: 'messages', header: 'Messages', numeric: true, cell: (d) => count(d.messages) },
    { key: 'sources', header: 'Sources', cell: (d) => <span className="pr-mono pr-wrap">{evidenceRowText(d).sources}</span> },
    { key: 'orgs', header: 'Reported by', cell: (d) => evidenceRowText(d).orgs },
  ];

  return (
    <Card as="li" data-proposal={result.domain} className="pr-admin-card">
      <CardBody>
        <CardTitle as="h3">{result.domain}</CardTitle>
        {result.eligible && proposal !== null ? (
          <Stack gap="12">
            <p>{proposalSummary(proposal)}</p>
            <Cluster gap="8">
              <code data-txt-value className="pr-dns-value">
                {proposal.txtValue}
              </code>
              <Button
                variant="secondary"
                onClick={() => {
                  copy(proposal.txtValue);
                }}
              >
                {copied ? 'Copied' : 'Copy TXT record'}
              </Button>
            </Cluster>
            <Table
              caption={`14-day evidence for ${result.domain}`}
              captionHidden
              columns={evidenceColumns}
              rows={proposal.evidence.days}
              rowKey={(d) => d.day}
              className="pr-admin-table"
            />
          </Stack>
        ) : (
          <p data-proposal-reason>{result.reason ?? 'Not eligible yet.'}</p>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * PST-REQ-122: DMARC aggregate and TLS-RPT reports mailed to the report mailbox, charted — pass and
 * fail by day, every sending source with its pass rate, each reporting organization, and TLS
 * session success and failure by policy.
 */
export function AdminDeliverability() {
  const [days, setDays] = useState('30');
  const [data, setData] = useState<Deliverability | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [proposals, setProposals] = useState<ProposalResult[] | null>(null);

  const load = useCallback(async (range: string) => {
    try {
      setData(await api.adminDeliverability(Number(range)));
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
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

  const sourceColumns: TableColumn<DeliverabilitySource>[] = [
    {
      key: 'sourceIp',
      header: 'Source',
      cell: (s) => (
        <span className="pr-mono">
          {s.sourceIp}
          {s.reverseDns === null ? null : <span className="pr-muted"> ({s.reverseDns})</span>}
        </span>
      ),
    },
    { key: 'orgs', header: 'Reported by', cell: (s) => s.orgs.join(', ') },
    { key: 'messages', header: 'Messages', numeric: true, cell: (s) => count(s.messages) },
    { key: 'pass', header: 'Pass', numeric: true, cell: (s) => count(s.pass) },
    { key: 'fail', header: 'Fail', numeric: true, cell: (s) => count(s.fail) },
    { key: 'passRate', header: 'Pass rate', numeric: true, cell: (s) => rateCell(s.passRate) },
  ];
  type OrgRow = Deliverability['dmarc']['byOrg'][number];
  const orgColumns: TableColumn<OrgRow>[] = [
    { key: 'org', header: 'Reporter', cell: (o) => o.org },
    { key: 'reports', header: 'Reports', numeric: true, cell: (o) => count(o.reports) },
    { key: 'messages', header: 'Messages', numeric: true, cell: (o) => count(o.messages) },
    { key: 'pass', header: 'Pass', numeric: true, cell: (o) => count(o.pass) },
    { key: 'fail', header: 'Fail', numeric: true, cell: (o) => count(o.fail) },
  ];
  type PolicyRow = Deliverability['tlsrpt']['byPolicy'][number];
  const policyColumns: TableColumn<PolicyRow>[] = [
    { key: 'policyDomain', header: 'Policy domain', cell: (p) => <span className="pr-mono">{p.policyDomain}</span> },
    { key: 'policyType', header: 'Policy', cell: (p) => p.policyType },
    { key: 'successful', header: 'Successful sessions', numeric: true, cell: (p) => count(p.successful) },
    { key: 'failed', header: 'Failed sessions', numeric: true, cell: (p) => count(p.failed) },
  ];
  type FailureRow = Deliverability['tlsrpt']['byFailureType'][number];
  const failureColumns: TableColumn<FailureRow>[] = [
    { key: 'resultType', header: 'Failure', cell: (f) => <span className="pr-mono">{f.resultType}</span> },
    { key: 'sessions', header: 'Sessions', numeric: true, cell: (f) => count(f.sessions) },
  ];

  const empty = data !== null && data.dmarc.totals.reports === 0 && data.tlsrpt.totals.reports === 0;

  return (
    <Page>
      <PageHeader
        title="Deliverability"
        description="DMARC aggregate and TLS reports from the providers you send to: who sends as your domain, and whether it authenticates."
        actions={
          <Button variant="secondary" onClick={() => void load(days)}>
            Refresh
          </Button>
        }
      />
      {proposals !== null && proposals.length > 0 ? (
        <Section
          surface="plain"
          title="DMARC progression"
          description="14 consecutive UTC days of only aligned passes from authorized sources earn a proposal to tighten the policy, with the evidence attached. Postroom never publishes DNS itself."
        >
          <Grid as="ul" minItemWidth="md" aria-label="DMARC progression proposals">
            {proposals.map((p) => (
              <ProposalCard key={p.domain} result={p} />
            ))}
          </Grid>
        </Section>
      ) : null}

      <FormField label="Range" width="sm">
        <Select appearance="filled" options={RANGES} value={days} onValueChange={setDays} />
      </FormField>

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
        <Stack gap="24">
          <Card as="section" aria-label="Summary" className="pr-admin-card pr-admin-stats">
            <StatGroup>
              <Stat
                data-stat="pass-rate"
                label="DMARC pass rate"
                value={percent(rateOf(data.dmarc.totals.pass, data.dmarc.totals.messages))}
                footnote={`${count(data.dmarc.totals.pass)} of ${count(data.dmarc.totals.messages)} messages`}
              />
              <FailedDmarcStat fail={data.dmarc.totals.fail} quarantine={data.dmarc.totals.dispositions.quarantine} reject={data.dmarc.totals.dispositions.reject} />
              <Stat data-stat="reports" label="Reports" value={count(data.dmarc.totals.reports)} footnote={`from ${count(data.dmarc.byOrg.length)} reporters`} />
              <Stat
                data-stat="tls"
                label="TLS sessions"
                value={count(data.tlsrpt.totals.successful + data.tlsrpt.totals.failed)}
                footnote={`${count(data.tlsrpt.totals.failed)} failed`}
              />
            </StatGroup>
          </Card>

          <Section title="DMARC by day" description="Messages the reporters saw from your domain, by the UTC day each report begins." className="pr-admin-card">
            <DayChart data={data} />
          </Section>

          <Section surface="plain" title="By source" description="Every IP address that sent mail as your domain. A low pass rate is either a spoofer or a service you have not authorized.">
            <Table
              caption="DMARC results by sending source"
              captionHidden
              columns={sourceColumns}
              rows={data.dmarc.bySource}
              rowKey={(s) => s.sourceIp}
              className="pr-admin-table"
              empty={<EmptyState kind="empty" heading="No sources in this range" size="row" />}
            />
          </Section>

          <Section surface="plain" title="By reporter">
            <Table
              caption="DMARC results by reporting organization"
              captionHidden
              columns={orgColumns}
              rows={data.dmarc.byOrg}
              rowKey={(o) => o.org}
              className="pr-admin-table"
              empty={<EmptyState kind="empty" heading="No reports in this range" size="row" />}
            />
          </Section>

          <Section surface="plain" title="TLS reports" description="SMTP TLS reporting (RFC 8460): sessions senders opened to your MX, by policy, and why any failed.">
            <Stack gap="16">
              <Table
                caption="TLS sessions by policy"
                captionHidden
                columns={policyColumns}
                rows={data.tlsrpt.byPolicy}
                rowKey={(p) => `${p.policyDomain}/${p.policyType}`}
                className="pr-admin-table"
                empty={<EmptyState kind="empty" heading="No TLS reports in this range" size="row" />}
              />
              {data.tlsrpt.byFailureType.length === 0 ? null : (
                <Table
                  caption="TLS failures by type"
                  columns={failureColumns}
                  rows={data.tlsrpt.byFailureType}
                  rowKey={(f) => f.resultType}
                  className="pr-admin-table"
                />
              )}
            </Stack>
          </Section>
        </Stack>
      )}
    </Page>
  );
}
