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
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { api, evidenceRowText, proposalSummary, type Deliverability, type DeliverabilitySource, type ProposalEvidenceDay, type ProposalResult } from '../api';
import { Loading, LoadFailed } from './states';

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

const PASS_FILL = { fill: 'var(--color-success)' };
const FAIL_FILL = { fill: 'var(--color-danger)' };
const AXIS_TEXT = { fill: 'var(--color-fg-muted)', fontSize: 'var(--text-12)' };
const AXIS_LINE = { stroke: 'var(--color-border)' };

/**
 * Stacked bars, pass under fail, one per UTC day — drawn as inline SVG (no chart library, no
 * third-party script: PST-REQ-159). The figure's accessible name says what it shows and its
 * description carries the totals, so the chart is not the only place the numbers live.
 */
function DayChart({ data }: { data: Deliverability }) {
  const titleId = useId();
  const descId = useId();
  const byDay = new Map(data.dmarc.byDay.map((d) => [d.day, d]));
  const days = daysIn(data.range.from, data.range.to, data.dmarc.byDay[0]?.day);
  const W = 640;
  const H = 220;
  const left = 44;
  const bottom = 24;
  const top = 8;
  const plotW = W - left - 8;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...days.map((d) => (byDay.get(d)?.pass ?? 0) + (byDay.get(d)?.fail ?? 0)));
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(1, slot * 0.7);
  const y = (v: number): number => top + plotH - (v / max) * plotH;
  const labelEvery = Math.ceil(days.length / 6);
  const { pass, fail } = data.dmarc.totals;

  return (
    <figure data-chart="dmarc-by-day">
      <svg viewBox={`0 0 ${String(W)} ${String(H)}`} width="100%" role="img" aria-labelledby={titleId} aria-describedby={descId} preserveAspectRatio="xMidYMid meet">
        <title id={titleId}>DMARC pass and fail by day</title>
        <desc id={descId}>{`${count(pass)} messages passed DMARC and ${count(fail)} failed across ${String(data.dmarc.byDay.length)} reported days.`}</desc>
        <line x1={left} x2={W - 8} y1={top + plotH} y2={top + plotH} style={AXIS_LINE} />
        <line x1={left} x2={left} y1={top} y2={top + plotH} style={AXIS_LINE} />
        <text x={left - 6} y={top + 10} textAnchor="end" style={AXIS_TEXT}>
          {count(max)}
        </text>
        <text x={left - 6} y={top + plotH} textAnchor="end" style={AXIS_TEXT}>
          0
        </text>
        {days.map((day, i) => {
          const row = byDay.get(day);
          const x = left + i * slot + (slot - barW) / 2;
          const p = row?.pass ?? 0;
          const f = row?.fail ?? 0;
          return (
            <g key={day} data-day={day}>
              {p > 0 ? (
                <rect x={x} width={barW} y={y(p)} height={top + plotH - y(p)} style={PASS_FILL}>
                  <title>{`${dayLabel(day)}: ${count(p)} passed`}</title>
                </rect>
              ) : null}
              {f > 0 ? (
                <rect x={x} width={barW} y={y(p + f)} height={y(p) - y(p + f)} style={FAIL_FILL}>
                  <title>{`${dayLabel(day)}: ${count(f)} failed`}</title>
                </rect>
              ) : null}
              {i % labelEvery === 0 ? (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" style={AXIS_TEXT}>
                  {dayLabel(day)}
                </text>
              ) : null}
            </g>
          );
        })}
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
              <rect width="12" height="12" style={FAIL_FILL} />
            </svg>{' '}
            Failed DMARC
          </span>
        </Cluster>
      </figcaption>
    </figure>
  );
}

function Stat({ title, value, detail, id }: { title: string; value: string; detail: string; id: string }) {
  return (
    <Card as="li" data-stat={id}>
      <CardBody>
        <CardTitle as="h3">{title}</CardTitle>
        <p data-stat-value>{value}</p>
        <p>{detail}</p>
      </CardBody>
    </Card>
  );
}

function rateBadge(rate: number) {
  if (rate >= 0.98) return <Badge tone="neutral">{percent(rate)}</Badge>;
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
    { key: 'day', header: 'Day (UTC)', cell: (d) => d.day },
    { key: 'reports', header: 'Reports', align: 'end', cell: (d) => count(d.reports) },
    { key: 'messages', header: 'Messages', align: 'end', cell: (d) => count(d.messages) },
    { key: 'sources', header: 'Sources', cell: (d) => evidenceRowText(d).sources },
    { key: 'orgs', header: 'Reported by', cell: (d) => evidenceRowText(d).orgs },
  ];

  return (
    <Card as="li" data-proposal={result.domain}>
      <CardBody>
        <CardTitle as="h3">{result.domain}</CardTitle>
        {result.eligible && proposal !== null ? (
          <Stack gap="12">
            <p>{proposalSummary(proposal)}</p>
            <Cluster gap="8">
              <code data-txt-value>{proposal.txtValue}</code>
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
              density="compact"
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
    { key: 'sourceIp', header: 'Source', cell: (s) => (s.reverseDns === null ? s.sourceIp : `${s.sourceIp} (${s.reverseDns})`) },
    { key: 'orgs', header: 'Reported by', cell: (s) => s.orgs.join(', ') },
    { key: 'messages', header: 'Messages', align: 'end', cell: (s) => count(s.messages) },
    { key: 'pass', header: 'Pass', align: 'end', cell: (s) => count(s.pass) },
    { key: 'fail', header: 'Fail', align: 'end', cell: (s) => count(s.fail) },
    { key: 'passRate', header: 'Pass rate', align: 'end', cell: (s) => rateBadge(s.passRate) },
  ];
  type OrgRow = Deliverability['dmarc']['byOrg'][number];
  const orgColumns: TableColumn<OrgRow>[] = [
    { key: 'org', header: 'Reporter', cell: (o) => o.org },
    { key: 'reports', header: 'Reports', align: 'end', cell: (o) => count(o.reports) },
    { key: 'messages', header: 'Messages', align: 'end', cell: (o) => count(o.messages) },
    { key: 'pass', header: 'Pass', align: 'end', cell: (o) => count(o.pass) },
    { key: 'fail', header: 'Fail', align: 'end', cell: (o) => count(o.fail) },
  ];
  type PolicyRow = Deliverability['tlsrpt']['byPolicy'][number];
  const policyColumns: TableColumn<PolicyRow>[] = [
    { key: 'policyDomain', header: 'Policy domain', cell: (p) => p.policyDomain },
    { key: 'policyType', header: 'Policy', cell: (p) => p.policyType },
    { key: 'successful', header: 'Successful sessions', align: 'end', cell: (p) => count(p.successful) },
    { key: 'failed', header: 'Failed sessions', align: 'end', cell: (p) => count(p.failed) },
  ];
  type FailureRow = Deliverability['tlsrpt']['byFailureType'][number];
  const failureColumns: TableColumn<FailureRow>[] = [
    { key: 'resultType', header: 'Failure', cell: (f) => f.resultType },
    { key: 'sessions', header: 'Sessions', align: 'end', cell: (f) => count(f.sessions) },
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
          title="DMARC progression"
          description="PST-REQ-123: 14 consecutive UTC days of only aligned passes from authorized sources earn a proposal to tighten the policy, with the evidence attached. Postroom never publishes DNS itself."
        >
          <Grid as="ul" minItemWidth="md" aria-label="DMARC progression proposals">
            {proposals.map((p) => (
              <ProposalCard key={p.domain} result={p} />
            ))}
          </Grid>
        </Section>
      ) : null}

      <FormField label="Range" width="sm">
        <Select options={RANGES} value={days} onValueChange={setDays} />
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
          <Section title="Summary" surface="plain">
            <Grid as="ul" minItemWidth="sm" aria-label="Summary">
              <Stat
                id="pass-rate"
                title="DMARC pass rate"
                value={percent(rateOf(data.dmarc.totals.pass, data.dmarc.totals.messages))}
                detail={`${count(data.dmarc.totals.pass)} of ${count(data.dmarc.totals.messages)} messages`}
              />
              <Stat id="failed" title="Failed DMARC" value={count(data.dmarc.totals.fail)} detail={`${count(data.dmarc.totals.dispositions.quarantine)} quarantined, ${count(data.dmarc.totals.dispositions.reject)} rejected`} />
              <Stat id="reports" title="Reports" value={count(data.dmarc.totals.reports)} detail={`from ${count(data.dmarc.byOrg.length)} reporters`} />
              <Stat
                id="tls"
                title="TLS sessions"
                value={count(data.tlsrpt.totals.successful + data.tlsrpt.totals.failed)}
                detail={`${count(data.tlsrpt.totals.failed)} failed`}
              />
            </Grid>
          </Section>

          <Section title="DMARC by day" description="Messages the reporters saw from your domain, by the UTC day each report begins.">
            <DayChart data={data} />
          </Section>

          <Section title="By source" description="Every IP address that sent mail as your domain. A low pass rate is either a spoofer or a service you have not authorized.">
            <Table
              caption="DMARC results by sending source"
              captionHidden
              columns={sourceColumns}
              rows={data.dmarc.bySource}
              rowKey={(s) => s.sourceIp}
              density="compact"
              empty={<EmptyState kind="empty" heading="No sources in this range" size="row" />}
            />
          </Section>

          <Section title="By reporter">
            <Table
              caption="DMARC results by reporting organization"
              captionHidden
              columns={orgColumns}
              rows={data.dmarc.byOrg}
              rowKey={(o) => o.org}
              density="compact"
              empty={<EmptyState kind="empty" heading="No reports in this range" size="row" />}
            />
          </Section>

          <Section title="TLS reports" description="SMTP TLS reporting (RFC 8460): sessions senders opened to your MX, by policy, and why any failed.">
            <Stack gap="16">
              <Table
                caption="TLS sessions by policy"
                captionHidden
                columns={policyColumns}
                rows={data.tlsrpt.byPolicy}
                rowKey={(p) => `${p.policyDomain}/${p.policyType}`}
                density="compact"
                empty={<EmptyState kind="empty" heading="No TLS reports in this range" size="row" />}
              />
              {data.tlsrpt.byFailureType.length === 0 ? null : (
                <Table
                  caption="TLS failures by type"
                  columns={failureColumns}
                  rows={data.tlsrpt.byFailureType}
                  rowKey={(f) => f.resultType}
                  density="compact"
                />
              )}
            </Stack>
          </Section>
        </Stack>
      )}
    </Page>
  );
}
