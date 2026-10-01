import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Button,
  Card,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Section,
  Stat,
  StatGroup,
  StatusDot,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { api, DNS_STATUS, type AdminQueueRecipient, type DnsCheckRow, type DnsReport, type HealthTile } from '../api';
import { Loading, LoadFailed } from './states';
import {
  TILE_TONE,
  certificateValue,
  durationShort,
  healthSummary,
  humanizeDetail,
  inboundQueueCounts,
  lastRunFootnote,
  lastRunStat,
  queueMeta,
  queueState,
  relativeTime,
  servicesMeta,
  sinceText,
  sortTiles,
  tileAction,
  tileById,
} from '../admin/health/model';
import '../admin/admin.css';

const REFRESH_MS = 30_000;
/** The Outbound queue card shows the first few rows; the Queue screen has the rest. */
const QUEUE_PREVIEW = 3;
const QUEUE_FETCH_LIMIT = 100;

interface QueueRow extends AdminQueueRecipient {
  createdAt: string;
}

function TileDot({ tile }: { tile: HealthTile }) {
  const { label, tone } = TILE_TONE[tile.state];
  return (
    <StatusDot tone={tone} size="sm">
      {label}
    </StatusDot>
  );
}

/** A Stat for one tile, or a quiet placeholder when the server sent no such tile. */
function TileStat({
  tile,
  label,
  value,
  unit,
  footnote,
}: {
  tile: HealthTile | undefined;
  label: string;
  value: string;
  unit?: string | undefined;
  footnote: string;
}) {
  return (
    <Stat
      data-stat={tile?.id}
      label={label}
      value={value}
      {...(unit === undefined ? {} : { unit })}
      footnote={footnote}
      status={
        tile === undefined ? (
          <StatusDot tone="idle" size="sm">
            Not reported
          </StatusDot>
        ) : (
          <TileDot tile={tile} />
        )
      }
    />
  );
}

function SummaryStats({ tiles, now }: { tiles: HealthTile[]; now: Date }) {
  const queue = tileById(tiles, 'queue');
  const cert = tileById(tiles, 'cert-expiry');
  const backup = tileById(tiles, 'backup');
  const drill = tileById(tiles, 'drill');
  const q = queue === undefined ? null : inboundQueueCounts(queue);
  const backupStat = backup === undefined ? { value: '—' } : lastRunStat(backup, now);
  const drillStat = drill === undefined ? { value: '—' } : lastRunStat(drill, now);
  return (
    <Card as="section" aria-label="Summary" className="pr-admin-card pr-admin-stats">
      <StatGroup>
        <TileStat
          tile={queue}
          label="Inbound queue"
          value={q === null ? (queue === undefined ? '—' : TILE_TONE[queue.state].label) : String(q.dead)}
          unit={q === null ? undefined : q.dead === 1 ? 'dead job' : 'dead jobs'}
          footnote={q === null ? (queue === undefined ? 'Not reported' : humanizeDetail(queue.detail)) : `${String(q.failed)} failed ${q.failed === 1 ? 'message' : 'messages'}`}
        />
        <TileStat tile={cert} label="Certificates" value={cert === undefined ? '—' : certificateValue(cert)} footnote={cert === undefined ? 'Not reported' : humanizeDetail(cert.detail)} />
        <TileStat
          tile={backup}
          label="Backups"
          value={backupStat.value}
          unit={backupStat.unit}
          footnote={backup === undefined ? 'Not reported' : lastRunFootnote(backup, 'backup')}
        />
        <TileStat
          tile={drill}
          label="Restore drill"
          value={drillStat.value}
          unit={drillStat.unit}
          footnote={drill === undefined ? 'Not reported' : lastRunFootnote(drill, 'drill')}
        />
      </StatGroup>
    </Card>
  );
}

function Services({ tiles, now }: { tiles: HealthTile[]; now: Date }) {
  const columns: TableColumn<HealthTile>[] = [
    {
      key: 'label',
      header: 'Service',
      width: '11rem',
      cell: (t) => (
        <span className="pr-health__svc" data-tile-id={t.id} data-tile-state={t.state}>
          {t.label}
        </span>
      ),
    },
    {
      key: 'detail',
      header: 'Detail',
      cell: (t) => {
        const action = tileAction(t);
        return (
          <>
            <span className="pr-muted pr-wrap">{humanizeDetail(t.detail)}</span>
            {/* The next step sits on its own line: a link inline in muted text differs from it by
                colour alone (1.61:1), which axe's link-in-text-block refuses (PST-REQ-154). */}
            {action === null ? null : (
              <span className="pr-health-action">
                {action.external ? (
                  <Link href={action.href} external target="_blank" rel="noopener noreferrer">
                    {action.label}
                  </Link>
                ) : (
                  <Link asChild>
                    <RouterLink to={action.href}>{action.label}</RouterLink>
                  </Link>
                )}
              </span>
            )}
          </>
        );
      },
    },
    {
      key: 'state',
      header: 'Status',
      align: 'end',
      width: '14rem',
      cell: (t) => {
        const since = sinceText(t, now);
        return (
          <span className="pr-health__state">
            <TileDot tile={t} />
            {since === null ? null : <span className="pr-muted pr-small">· {since}</span>}
          </span>
        );
      },
    },
  ];
  return (
    <Section title="Services" description={servicesMeta(tiles)} className="pr-admin-card" data-section="services">
      <Table className="pr-admin-table" caption="Services" captionHidden columns={columns} rows={sortTiles(tiles)} rowKey={(t) => t.id} />
    </Section>
  );
}

/** Tunnel and blocklist: the two checks that look at Postroom from outside. */
function Edge({ tiles }: { tiles: HealthTile[] }) {
  const rows = [tileById(tiles, 'tunnel'), tileById(tiles, 'blocklist')].filter((t): t is HealthTile => t !== undefined);
  return (
    <Section title="Edge" className="pr-admin-card">
      {rows.length === 0 ? (
        <p className="pr-muted pr-small">No edge checks reported.</p>
      ) : (
        <DescriptionList>
          {rows.map((t) => (
            <DescriptionItem key={t.id} term={t.label}>
              <span className="pr-health__kv">
                <TileDot tile={t} />
                <span className="pr-muted">{humanizeDetail(t.detail)}</span>
              </span>
            </DescriptionItem>
          ))}
        </DescriptionList>
      )}
    </Section>
  );
}

const AUTH_RECORDS = ['SPF', 'DKIM', 'DMARC'] as const;

/** The worst row of one record kind (a domain can have several DKIM selectors). */
function worstRow(rows: readonly DnsCheckRow[], record: string): DnsCheckRow | undefined {
  const order = ['fail', 'missing', 'unknown', 'pending', 'pass'];
  return rows.filter((r) => r.record === record).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
}

/** SPF, DKIM and DMARC as the DNS & DKIM screen checks them, plus the blocklist tile. */
function Deliverability({ dns, dnsFailed, tiles }: { dns: DnsReport | null; dnsFailed: boolean; tiles: HealthTile[] }) {
  const blocklist = tileById(tiles, 'blocklist');
  return (
    <Section
      title="Deliverability"
      {...(dns === null ? {} : { description: dns.domain })}
      className="pr-admin-card"
      actions={
        <Link asChild>
          <RouterLink to="/admin/dns">DNS &amp; DKIM</RouterLink>
        </Link>
      }
    >
      {dnsFailed ? (
        <p className="pr-muted pr-small">Could not check DNS just now.</p>
      ) : dns === null ? (
        <Loading label="Checking DNS" height={96} />
      ) : (
        <DescriptionList>
          {AUTH_RECORDS.map((record) => {
            const row = worstRow(dns.rows, record);
            if (row === undefined) return null;
            const s = DNS_STATUS[row.status];
            return (
              <DescriptionItem key={record} term={record}>
                <span className="pr-health__kv">
                  <StatusDot tone={row.status === 'pending' ? 'idle' : s.tone} size="sm">
                    {s.label}
                  </StatusDot>
                  <span className="pr-muted" title={row.reason}>
                    {row.reason}
                  </span>
                </span>
              </DescriptionItem>
            );
          })}
          {blocklist === undefined ? null : (
            <DescriptionItem term="Blocklists">
              <TileDot tile={blocklist} />
            </DescriptionItem>
          )}
        </DescriptionList>
      )}
    </Section>
  );
}

function OutboundQueue({ rows, limited, failed, now }: { rows: QueueRow[] | null; limited: boolean; failed: boolean; now: Date }) {
  const columns: TableColumn<QueueRow>[] = [
    { key: 'address', header: 'Recipient', cell: (r) => <span className="pr-mono" title={r.address}>{r.address}</span> },
    {
      key: 'state',
      header: 'State',
      width: '7rem',
      cell: (r) => {
        const s = queueState(r.state);
        return (
          <StatusDot tone={s.tone} size="sm">
            {s.label}
          </StatusDot>
        );
      },
    },
    {
      key: 'age',
      header: 'Age',
      align: 'end',
      numeric: true,
      width: '5.5rem',
      cell: (r) => <span className="pr-mono pr-muted">{durationShort(now.getTime() - Date.parse(r.createdAt))}</span>,
    },
  ];
  return (
    <Section
      title="Outbound queue"
      {...(rows === null ? {} : { description: queueMeta(rows, limited) })}
      className="pr-admin-card"
      actions={
        <Link asChild>
          <RouterLink to="/admin/queue">
            View queue <span aria-hidden="true">→</span>
          </RouterLink>
        </Link>
      }
    >
      {failed ? (
        <p className="pr-muted pr-small">Could not load the queue just now.</p>
      ) : rows === null ? (
        <Loading label="Loading the queue" height={96} />
      ) : rows.length === 0 ? null : (
        <Table
          className="pr-admin-table pr-admin-table--fixed"
          caption="First recipients in the outbound queue"
          captionHidden
          columns={columns}
          rows={rows.slice(0, QUEUE_PREVIEW)}
          rowKey={(r) => r.id}
        />
      )}
    </Section>
  );
}

/**
 * PST-REQ-127: tunnel, daemons, certificates, disk, queue, backup, drill and NTP — the header says in
 * one line whether anything needs you, four Stats answer the questions asked most, the Services list
 * has every check, and the side cards pull in the edge, DNS authentication and the outbound queue
 * from the endpoints their own screens use. Auto-refreshes every 30 s while the tab is open.
 *
 * There is no "Run drill" button: no API triggers a restore drill (the worker runs it on its own
 * schedule), so the Restore drill Stat reports the last run and nothing more.
 */
export function AdminHealth() {
  const [tiles, setTiles] = useState<HealthTile[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [queue, setQueue] = useState<{ rows: QueueRow[]; limited: boolean } | null>(null);
  const [queueFailed, setQueueFailed] = useState(false);
  const [dns, setDns] = useState<DnsReport | null>(null);
  const [dnsFailed, setDnsFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadQueue = useCallback(async () => {
    try {
      const result = await api.adminQueue({ limit: QUEUE_FETCH_LIMIT });
      const rows = result.messages.flatMap((m) => m.recipients.map((r) => ({ ...r, createdAt: m.createdAt })));
      rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      setQueue({ rows, limited: rows.length >= QUEUE_FETCH_LIMIT });
      setQueueFailed(false);
    } catch {
      setQueueFailed(true);
    }
  }, []);

  const loadDns = useCallback(async () => {
    try {
      setDns(await api.dnsCheck());
      setDnsFailed(false);
    } catch {
      setDnsFailed(true);
    }
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setTiles((await api.adminHealth()).tiles);
      setCheckedAt(new Date());
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    } finally {
      setRefreshing(false);
    }
    await loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    void load();
    // DNS is looked up live through the resolver, so it is checked on arrival and on Refresh, not
    // every 30 s.
    void loadDns();
    timer.current = setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, [load, loadDns]);

  const now = checkedAt ?? new Date();
  const summary = tiles === null ? null : healthSummary(tiles);

  return (
    <Page>
      <PageHeader
        title="Health"
        description={
          summary === null || checkedAt === null ? (
            'Tunnel, daemons, certificates, disk, the inbound queue, backups and the restore drill.'
          ) : (
            <span className="pr-health__summary">
              <StatusDot tone={summary.tone}>{summary.text}</StatusDot>
              <span>· checked {relativeTime(checkedAt.toISOString(), new Date())}</span>
            </span>
          )
        }
        actions={
          <Button
            variant="secondary"
            loading={refreshing}
            onClick={() => {
              void load();
              void loadDns();
            }}
          >
            Refresh
          </Button>
        }
      />
      {loadError !== null ? (
        <LoadFailed error={loadError} what="health" onRetry={() => void load()} />
      ) : tiles === null ? (
        <Loading label="Loading health" />
      ) : tiles.length === 0 ? (
        <EmptyState kind="empty" heading="No health checks reported" headingLevel={2}>
          The server answered, but with nothing to check. Refresh once the daemons are up.
        </EmptyState>
      ) : (
        <>
          <SummaryStats tiles={tiles} now={now} />
          <div className="pr-health__cols">
            <div className="pr-health__stack">
              <Services tiles={tiles} now={now} />
            </div>
            <div className="pr-health__stack">
              <Edge tiles={tiles} />
              <Deliverability dns={dns} dnsFailed={dnsFailed} tiles={tiles} />
              <OutboundQueue rows={queue?.rows ?? null} limited={queue?.limited ?? false} failed={queueFailed} now={now} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
