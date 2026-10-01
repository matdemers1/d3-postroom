import { Fragment, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  DataList,
  DataListRow,
  EmptyState,
  FilterBar,
  IconButton,
  Page,
  PageHeader,
  SegmentedControl,
  Stack,
  StatusDot,
  type StatusDotTone,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { api, DNS_STATUS, dnsSummary, serverUnreachable, type DnsCheckRow, type DnsReport, type DnsStatus } from '../api';
import { RelativeTime } from '../components/RelativeTime';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import { Loading } from './states';
import '../admin/admin.css';
import '../admin/lists.css';

const CopyGlyph = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </svg>
);

const CheckGlyph = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 12 5 5 9-10" />
  </svg>
);

/**
 * Copies one value; says so in its own label for a moment, so a screen reader hears it too.
 * `compact` is the inline form for a table cell or a card (PST-T-17.2): a 16px glyph in a 28px hit
 * area at the end of the value, instead of a word button stacked under it.
 */
export function CopyButton({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => {
      setCopied(false);
    }, 2_000);
    return () => {
      clearTimeout(t);
    };
  }, [copied]);
  const name = copied ? `Copied ${label}` : `Copy ${label}`;
  const copy = (): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
      })
      .catch(() => undefined);
  };
  if (compact) return <IconButton size="sm" variant="ghost" label={name} icon={copied ? <CheckGlyph /> : <CopyGlyph />} onClick={copy} />;
  return (
    <Button size="sm" variant="secondary" aria-label={name} onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// A DNS value is long and unbroken (a DKIM RSA key is ~400 characters): wrap it anywhere, in the
// monospace face (admin.css), so a 390 px screen never scrolls sideways because of one.
export function DnsValue({ children }: { children: string }) {
  return <code className="pr-dns-value">{children}</code>;
}

// --- The model: groups, order, labels (pure, unit-tested) ---------------------------------------

export type DnsGroupId = 'mail' | 'auth' | 'transport' | 'discovery' | 'mailboxes';

/** The order a person reads a zone in (critique 2.4 #3): how mail arrives, then who may send it, … */
export const DNS_GROUPS: readonly { id: DnsGroupId; title: string }[] = [
  { id: 'mail', title: 'Mail flow' },
  { id: 'auth', title: 'Authentication' },
  { id: 'transport', title: 'Transport security' },
  { id: 'discovery', title: 'Client discovery' },
  { id: 'mailboxes', title: 'Role mailboxes' },
];

export function dnsGroupOf(row: Pick<DnsCheckRow, 'record' | 'type'>): DnsGroupId {
  switch (row.record) {
    case 'MX':
    case 'PTR':
      return 'mail';
    case 'SPF':
    case 'DKIM':
    case 'DMARC':
      return 'auth';
    case 'MTA-STS':
    case 'MTA-STS host':
    case 'TLS-RPT':
      return 'transport';
    default:
      return row.type === 'RCPT' ? 'mailboxes' : 'discovery';
  }
}

/** Worst first inside a group: what is wrong, then what is absent, then what is waiting. */
const STATUS_ORDER: Record<DnsStatus, number> = { fail: 0, missing: 1, unknown: 2, pending: 3, pass: 4 };

/** A record that does not pass needs the operator, sooner or later (pending ones after go-live). */
export const needsAttention = (row: Pick<DnsCheckRow, 'status'>): boolean => row.status !== 'pass';

/** The groups that have rows, each sorted worst first; the server's order breaks ties. */
export function groupDnsRows<R extends Pick<DnsCheckRow, 'record' | 'type' | 'status'>>(rows: readonly R[]): { id: DnsGroupId; title: string; rows: R[] }[] {
  return DNS_GROUPS.map((g) => ({
    ...g,
    rows: rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => dnsGroupOf(row) === g.id)
      .sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || a.index - b.index)
      .map(({ row }) => row),
  })).filter((g) => g.rows.length > 0);
}

const SRV_SERVICE: Record<string, string> = {
  _submissions: 'Submission',
  _submission: 'Submission',
  _imaps: 'IMAP',
  _imap: 'IMAP',
  _caldavs: 'CalDAV',
  _caldav: 'CalDAV',
  _carddavs: 'CardDAV',
  _carddav: 'CardDAV',
};

/**
 * The friendly name, and the DNS type only where it says something the name does not (2.4 #4): "MX",
 * not "MX MX"; "IMAP" + "SRV" for `_imaps._tcp`; "SPF" + "TXT". RCPT is not a DNS type (it is an
 * address checked in Postroom's own database), so it is never shown.
 */
export function dnsLabel(row: Pick<DnsCheckRow, 'record' | 'type' | 'name'>): { label: string; type: string | null } {
  const label = row.type === 'SRV' ? (SRV_SERVICE[row.name.split('.')[0] ?? ''] ?? row.record) : row.record;
  const type = row.type === 'RCPT' || label.toUpperCase() === row.type ? null : row.type;
  return { label, type };
}

/** A DNS name in pieces that each end at a dot (or an @): the only places it may break (2.4 #4). */
export function dnsNameParts(name: string): string[] {
  return name.split(/(?<=[.@])/).filter((p) => p !== '');
}

export function DnsName({ name }: { name: string }) {
  const parts = dnsNameParts(name);
  return (
    <span className="pr-dns-name">
      {parts.map((part, i) => (
        <Fragment key={`${String(i)}:${part}`}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </span>
  );
}

/** D-016: a passing record is neutral, a pending one idle; only a wrong or absent one takes a hue. */
const STATUS_TONE: Record<DnsStatus, StatusDotTone> = { pass: 'neutral', pending: 'idle', unknown: 'attention', fail: 'danger', missing: 'danger' };

function DnsStatusDot({ status }: { status: DnsStatus }) {
  return (
    <StatusDot size="sm" tone={STATUS_TONE[status]}>
      {DNS_STATUS[status].label}
    </StatusDot>
  );
}

function RecordLabel({ row }: { row: DnsCheckRow }) {
  const { label, type } = dnsLabel(row);
  return (
    <span className="pr-dns-record__label" {...(row.note === null ? {} : { title: row.note })}>
      {label}
      {type === null ? null : <span className="pr-dns-record__type">{type}</span>}
    </span>
  );
}

const copyLabel = (row: DnsCheckRow): string => `expected ${row.record} value for ${row.name}`;

/** The expected value, clamped, with Copy at its end. Prose never goes here: no value is a dash. */
function ExpectedValue({ row, lines }: { row: DnsCheckRow; lines: 2 | 3 }) {
  if (row.expected === null) return <span className="pr-muted pr-dns-cell">—</span>;
  return (
    <span className="pr-dns-value-row">
      <code className={`pr-dns-clamp pr-clamp${lines === 3 ? ' pr-clamp--3' : ''}`} title={row.expected}>
        {row.expected}
      </code>
      <CopyButton compact value={row.expected} label={copyLabel(row)} />
    </span>
  );
}

function LiveValues({ row }: { row: DnsCheckRow }) {
  if (row.live.length === 0) return <span className="pr-muted pr-dns-cell">Nothing published</span>;
  const differs = row.status === 'fail' && row.expected !== null;
  return (
    <span className="pr-dns-live pr-dns-cell">
      {row.live.map((v, i) => (
        <code key={`${String(i)}:${v}`} className={`pr-dns-clamp pr-clamp${differs && v !== row.expected ? ' pr-dns-live__value--differs' : ''}`} title={v}>
          {differs && v !== row.expected ? (
            <>
              <span className="pr-dns-live__mark" aria-hidden="true">
                ≠
              </span>
              <span className="pr-sr-only">Differs: </span>
            </>
          ) : null}
          {v}
        </code>
      ))}
    </span>
  );
}

function columnsFor(): TableColumn<DnsCheckRow>[] {
  return [
    {
      key: 'record',
      header: 'Record',
      width: '15rem',
      cell: (r) => (
        <span className="pr-dns-record pr-dns-cell">
          <RecordLabel row={r} />
          <DnsName name={r.name} />
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      cell: (r) => (
        <span className="pr-dns-cell">
          <DnsStatusDot status={r.status} />
        </span>
      ),
    },
    { key: 'expected', header: 'Expected', width: 'auto', cell: (r) => <ExpectedValue row={r} lines={2} /> },
    { key: 'live', header: 'Live', width: 'auto', cell: (r) => <LiveValues row={r} /> },
    {
      key: 'reason',
      header: 'Why',
      width: '24%',
      cell: (r) => (
        <span className="pr-dns-cell pr-clamp" title={r.reason}>
          {r.reason}
        </span>
      ),
    },
  ];
}

/**
 * One block of records: a table at desktop widths, one card per record on a phone (2.4 #1) — the
 * name, the verdict, the expected value with Copy, and why only when it does not pass.
 */
function DnsRecordList({ rows, caption, phone }: { rows: DnsCheckRow[]; caption: string; phone: boolean }) {
  if (phone) {
    return (
      <DataList aria-label={caption} empty={<EmptyState kind="empty" heading="No records to check" headingLevel={3} size="inline" />}>
        {rows.map((r) => (
          <DataListRow
            key={`${r.record}:${r.name}`}
            title={<RecordLabel row={r} />}
            meta={<DnsStatusDot status={r.status} />}
            truncate={false}
            description={
              <span className="pr-dns-card">
                <DnsName name={r.name} />
                {r.expected === null ? null : <ExpectedValue row={r} lines={3} />}
                {needsAttention(r) ? <span className="pr-dns-card__why">{r.reason}</span> : null}
              </span>
            }
          />
        ))}
      </DataList>
    );
  }
  return (
    <Table
      className="pr-admin-table pr-admin-table--fixed pr-dns-records"
      caption={caption}
      captionHidden
      columns={columnsFor()}
      rows={rows}
      rowKey={(r) => `${r.record}:${r.name}`}
      empty={<EmptyState kind="empty" heading="No records to check" size="row" />}
    />
  );
}

/** Expected vs live, one row per record, with the verdict and why (PST-REQ-099). Worst first. */
export function DnsTable({ report }: { report: DnsReport }) {
  const phone = useMediaQuery(PHONE_QUERY);
  const rows = groupDnsRows(report.rows).flatMap((g) => g.rows);
  return <DnsRecordList rows={rows} caption={`DNS records for ${report.domain}`} phone={phone} />;
}

export function ResolverNote({ report }: { report: DnsReport }) {
  return (
    <Alert tone="info" title="Answers come from Postroom’s own resolver">
      Every live value was looked up just now through {report.resolver}, the validating resolver the mail daemons use — not your browser’s. A record you
      changed a moment ago may still be cached there until its TTL runs out. Nothing is ever checked or suggested for the no-reply subdomain, which belongs
      to Cloudflare Email Service.
    </Alert>
  );
}

/** Loads (and re-checks) the report for one domain. */
export function useDnsReport(domain?: string) {
  const [report, setReport] = useState<DnsReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setReport(await api.dnsCheck(domain));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  }, [domain]);
  useEffect(() => {
    void check();
  }, [check]);
  return { report, failed, checking, check };
}

export type DnsShow = 'attention' | 'all';

/** ?show= wins; with none, "Needs attention" whenever anything does (2.4 #3), else everything. */
export function dnsShowFrom(param: string | null, attentionCount: number): DnsShow {
  if (param === 'all' || param === 'attention') return param;
  return attentionCount > 0 ? 'attention' : 'all';
}

/** Admin → DNS records: what Postroom needs published, what is published, and whether it is right. */
export function AdminDns() {
  const { report, failed, checking, check } = useDnsReport();
  const phone = useMediaQuery(PHONE_QUERY);
  const [params, setParams] = useSearchParams();
  const attention = report === null ? 0 : report.rows.filter(needsAttention).length;
  const show = dnsShowFrom(params.get('show'), attention);
  const setShow = (next: string): void => {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.set('show', next);
        return out;
      },
      { replace: true },
    );
  };
  const groups = report === null ? [] : groupDnsRows(show === 'all' ? report.rows : report.rows.filter(needsAttention));

  return (
    <Page>
      <PageHeader
        title="DNS & DKIM"
        description={
          report === null ? (
            'Expected and live values for every record Postroom needs.'
          ) : (
            <>
              {report.domain} · checked <RelativeTime iso={report.checkedAt} />
            </>
          )
        }
        actions={
          <Button
            loading={checking}
            onClick={() => {
              void check();
            }}
          >
            Re-check
          </Button>
        }
      />
      {failed ? (
        <EmptyState kind="error" heading="Could not check DNS" headingLevel={2} action={<Button onClick={() => void check()}>Try again</Button>}>
          {serverUnreachable()}
        </EmptyState>
      ) : report === null ? (
        <Loading label="Checking DNS" />
      ) : (
        <Stack gap="12">
          <Card className="pr-table-card">
            <div className="pr-table-toolbar">
              <FilterBar aria-label="Filter DNS records" trailing={<span>{dnsSummary(report.summary)}</span>}>
                <SegmentedControl
                  aria-label="Records shown"
                  items={[
                    { value: 'attention', label: 'Needs attention', count: attention },
                    { value: 'all', label: 'All', count: report.rows.length },
                  ]}
                  value={show}
                  onValueChange={setShow}
                />
              </FilterBar>
            </div>
            {groups.length === 0 ? (
              <EmptyState kind="empty" heading="Every record checks out" headingLevel={2} size="inline">
                Nothing needs you here. Choose All to see every record.
              </EmptyState>
            ) : (
              groups.map((g) => (
                <div key={g.id} className="pr-dns-group">
                  <h2 className="pr-dns-group__title">{g.title}</h2>
                  <DnsRecordList rows={g.rows} caption={`${g.title} records for ${report.domain}`} phone={phone} />
                </div>
              ))
            )}
          </Card>
          <p className="pr-list-footnote">
            Looked up just now through {report.resolver}, the mail daemons’ own validating resolver, not your browser’s; a record changed a moment ago may
            still be cached until its TTL runs out. Nothing is checked for the no-reply subdomain, which belongs to Cloudflare Email Service.
          </p>
        </Stack>
      )}
    </Page>
  );
}
