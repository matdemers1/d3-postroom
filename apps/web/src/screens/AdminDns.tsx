import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, EmptyState, Page, PageHeader, Skeleton, Stack, Table, type TableColumn } from '@d3cloud/ui';
import { api, DNS_STATUS, dnsSummary, serverUnreachable, type DnsCheckRow, type DnsReport } from '../api';
import '../admin/admin.css';

/** Copies one value; says so in its own label for a moment, so a screen reader hears it too. */
export function CopyButton({ value, label }: { value: string; label: string }) {
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
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// A DNS value is long and unbroken (a DKIM RSA key is ~400 characters): wrap it anywhere, in the
// monospace face (admin.css), so a 390 px screen never scrolls sideways because of one.
export function DnsValue({ children }: { children: string }) {
  return <code className="pr-dns-value">{children}</code>;
}

/** Expected vs live, one row per record, with the verdict and why (PST-REQ-099). */
export function DnsTable({ report }: { report: DnsReport }) {
  const columns: TableColumn<DnsCheckRow>[] = [
    {
      key: 'record',
      header: 'Record',
      width: 'minmax(8rem, 1fr)',
      cell: (r) => (
        <Stack gap="4">
          <span>
            {r.record} <span className="pr-muted pr-small">{r.type}</span>
          </span>
          <DnsValue>{r.name}</DnsValue>
        </Stack>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '6rem',
      cell: (r) => (
        <Badge size="sm" tone={DNS_STATUS[r.status].tone}>
          {DNS_STATUS[r.status].label}
        </Badge>
      ),
    },
    {
      key: 'expected',
      header: 'Expected',
      width: 'minmax(10rem, 2fr)',
      cell: (r) =>
        r.expected === null ? (
          <span className="pr-muted pr-small">{r.note ?? 'Not known yet'}</span>
        ) : (
          <Stack gap="4">
            <DnsValue>{r.expected}</DnsValue>
            <div>
              <CopyButton value={r.expected} label={`expected ${r.record} value for ${r.name}`} />
            </div>
          </Stack>
        ),
    },
    {
      key: 'live',
      header: 'Live',
      width: 'minmax(10rem, 2fr)',
      cell: (r) =>
        r.live.length === 0 ? (
          <span className="pr-muted pr-small">Nothing published</span>
        ) : (
          <Stack gap="4">
            {r.live.map((v, i) => (
              <DnsValue key={`${String(i)}:${v}`}>{v}</DnsValue>
            ))}
          </Stack>
        ),
    },
    { key: 'reason', header: 'Why', width: 'minmax(10rem, 2fr)', cell: (r) => <span className="pr-wrap">{r.reason}</span> },
  ];
  return (
    <Table
      className="pr-admin-table pr-dns-table"
      caption={`DNS records for ${report.domain}`}
      captionHidden
      columns={columns}
      rows={report.rows}
      rowKey={(r) => `${r.record}:${r.name}`}
      empty={<EmptyState kind="empty" heading="No records to check" size="row" />}
    />
  );
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

/** Admin → DNS records: what Postroom needs published, what is published, and whether it is right. */
export function AdminDns() {
  const { report, failed, checking, check } = useDnsReport();
  return (
    <Page>
      <PageHeader
        title="DNS & DKIM"
        description={
          report === null
            ? 'Expected and live values for every record Postroom needs.'
            : `${report.domain} — ${dnsSummary(report.summary)} · checked ${new Date(report.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}`
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
        <Skeleton variant="block" />
      ) : (
        <Stack gap="16">
          <ResolverNote report={report} />
          <DnsTable report={report} />
        </Stack>
      )}
    </Page>
  );
}
