import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, EmptyState, Page, PageHeader, Skeleton, Stack, Table, type TableColumn } from '@d3cloud/ui';
import { api, DNS_STATUS, dnsSummary, type DnsCheckRow, type DnsReport } from '../api';

// A DNS value is long and unbroken (a DKIM RSA key is ~400 characters): wrap it anywhere, in the
// monospace face, so a 390 px screen never scrolls sideways because of one.
const valueStyle = { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-12)', overflowWrap: 'anywhere', wordBreak: 'break-word' } as const;
const mutedStyle = { color: 'var(--color-fg-muted)', fontSize: 'var(--text-12)' } as const;

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

export function DnsValue({ children }: { children: string }) {
  return <code style={valueStyle}>{children}</code>;
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
            {r.record} <span style={mutedStyle}>{r.type}</span>
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
          <span style={mutedStyle}>{r.note ?? 'Not known yet'}</span>
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
          <span style={mutedStyle}>Nothing published</span>
        ) : (
          <Stack gap="4">
            {r.live.map((v, i) => (
              <DnsValue key={`${String(i)}:${v}`}>{v}</DnsValue>
            ))}
          </Stack>
        ),
    },
    { key: 'reason', header: 'Why', width: 'minmax(10rem, 2fr)', cell: (r) => r.reason },
  ];
  return (
    <Table
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
        title="DNS records"
        description={report === null ? 'Expected and live values for every record Postroom needs.' : `${report.domain} — ${dnsSummary(report.summary)}`}
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
          The server did not answer.
        </EmptyState>
      ) : report === null ? (
        <Skeleton variant="block" />
      ) : (
        <Stack gap="16">
          <ResolverNote report={report} />
          <p style={mutedStyle}>Checked {new Date(report.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}.</p>
          <DnsTable report={report} />
        </Stack>
      )}
    </Page>
  );
}
