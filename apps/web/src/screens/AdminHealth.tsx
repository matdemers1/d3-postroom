import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Button, Card, DataList, DataListRow, EmptyState, IconButton, Link, Page, PageHeader, Stat, StatGroup, StatusDot, Table, type TableColumn } from '@d3cloud/ui';
import { api, DNS_STATUS, type AdminQueueRecipient, type DnsCheckRow, type DnsReport, type HealthTile } from '../api';
import { Loading, LoadFailed } from './states';
import { RelativeTime, relativeTime } from '../components/RelativeTime';
import { PHONE_QUERY, useMediaQuery } from '../mail/useMedia';
import {
  TILE_TONE,
  certificateStat,
  healthSummary,
  inboundQueueStat,
  lastRunView,
  queueMeta,
  queueState,
  serviceName,
  servicesMeta,
  sincePrefix,
  sortTiles,
  tileAction,
  tileById,
  tileDetail,
  type StatView,
} from '../admin/health/model';
import { CardHead } from '../admin/health/CardHead';
import { RefreshIcon } from '../admin/health/RefreshIcon';
import { useContextBarAction } from '../mobile/barSlot';
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

/** One Stat: a number or "—" in the value slot, a status under it, and a one-line footnote. */
function TileStat({ id, label, view }: { id: string; label: string; view: StatView }) {
  return (
    <Stat
      data-stat={id}
      label={label}
      value={view.value}
      {...(view.unit === undefined ? {} : { unit: view.unit })}
      footnote={
        <span className="pr-stat-foot" title={view.ran === undefined ? view.footnote : `${view.ran.prefix} ${relativeTime(view.ran.iso)} · ${view.footnote}`}>
          {view.ran === undefined ? null : (
            <>
              {view.ran.prefix} <RelativeTime iso={view.ran.iso} /> ·{' '}
            </>
          )}
          {view.footnote}
        </span>
      }
      status={
        <StatusDot tone={view.status.tone} size="sm">
          {view.status.label}
        </StatusDot>
      }
    />
  );
}

function SummaryStats({ tiles, now }: { tiles: HealthTile[]; now: Date }) {
  return (
    <Card as="section" aria-label="Summary" className="pr-admin-stats">
      <StatGroup>
        <TileStat id="queue" label="Inbound queue" view={inboundQueueStat(tileById(tiles, 'queue'))} />
        <TileStat id="cert-expiry" label="Certificates" view={certificateStat(tileById(tiles, 'cert-expiry'))} />
        <TileStat id="backup" label="Backups" view={lastRunView(tileById(tiles, 'backup'), 'backup', now)} />
        <TileStat id="drill" label="Restore drill" view={lastRunView(tileById(tiles, 'drill'), 'drill', now)} />
      </StatGroup>
    </Card>
  );
}

/** The fix for a failing check, on its own line: a link inline in muted text differs from it by
 * colour alone (1.61:1), which axe's link-in-text-block refuses (PST-REQ-154). */
function TileFix({ tile }: { tile: HealthTile }) {
  const action = tileAction(tile);
  if (action === null) return null;
  return (
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
  );
}

/** The detail, then when it last ran or changed as a muted suffix (2.1 #2) — or "—" when the detail
 * would only restate the status (2.1 #4, #7). */
function TileDetailText({ tile }: { tile: HealthTile }) {
  const detail = tileDetail(tile);
  const prefix = sincePrefix(tile);
  if (detail === null && (prefix === null || tile.since === null)) return <span className="pr-muted">—</span>;
  return (
    <span className="pr-muted">
      {detail}
      {prefix === null || tile.since === null ? null : (
        <>
          {detail === null ? null : ' · '}
          <span className="pr-nowrap">
            {prefix} <RelativeTime iso={tile.since} />
          </span>
        </>
      )}
    </span>
  );
}

function ServiceName({ tile }: { tile: HealthTile }) {
  return (
    <span className="pr-health__svc" data-tile-id={tile.id} data-tile-state={tile.state}>
      {serviceName(tile)}
    </span>
  );
}

function Services({ tiles, phone }: { tiles: HealthTile[]; phone: boolean }) {
  const headId = useId();
  const sorted = sortTiles(tiles);
  const columns: TableColumn<HealthTile>[] = [
    { key: 'label', header: 'Service', width: '12rem', cell: (t) => <ServiceName tile={t} /> },
    {
      key: 'detail',
      header: 'Detail',
      width: 'auto',
      cell: (t) => (
        <>
          <span className="pr-wrap">
            <TileDetailText tile={t} />
          </span>
          <TileFix tile={t} />
        </>
      ),
    },
    { key: 'state', header: 'Status', align: 'end', width: '9rem', cell: (t) => <TileDot tile={t} /> },
  ];
  return (
    <Card as="section" aria-labelledby={headId} className="pr-table-card" data-section="services">
      <CardHead id={headId} title="Services" meta={servicesMeta(tiles)} />
      {phone ? (
        <DataList aria-label="Services" className="pr-card-list">
          {sorted.map((t) => {
            const fix = tileAction(t);
            return (
              <DataListRow
                key={t.id}
                title={<ServiceName tile={t} />}
                {...(tileDetail(t) === null && t.since === null ? {} : { description: <TileDetailText tile={t} /> })}
                meta={<TileDot tile={t} />}
                {...(fix === null ? {} : { actions: <TileFix tile={t} /> })}
              />
            );
          })}
        </DataList>
      ) : (
        <Table className="pr-admin-table pr-admin-table--fixed" caption="Services" captionHidden columns={columns} rows={sorted} rowKey={(t) => t.id} />
      )}
    </Card>
  );
}

const AUTH_RECORDS = ['SPF', 'DKIM', 'DMARC'] as const;

/** The worst row of one record kind (a domain can have several DKIM selectors). */
function worstRow(rows: readonly DnsCheckRow[], record: string): DnsCheckRow | undefined {
  const order = ['fail', 'missing', 'unknown', 'pending', 'pass'];
  return rows.filter((r) => r.record === record).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
}

/** SPF, DKIM and DMARC as the DNS & DKIM screen checks them: one row each, a status and one line. */
function Deliverability({ dns, dnsFailed }: { dns: DnsReport | null; dnsFailed: boolean }) {
  const headId = useId();
  return (
    <Card as="section" aria-labelledby={headId} className="pr-table-card" data-section="deliverability">
      <CardHead
        id={headId}
        title="Deliverability"
        meta={dns?.domain}
        end={
          <Link asChild>
            <RouterLink to="/admin/dns">
              DNS &amp; DKIM <span aria-hidden="true">→</span>
            </RouterLink>
          </Link>
        }
      />
      {dnsFailed ? (
        <p className="pr-card-note">Could not check DNS just now.</p>
      ) : dns === null ? (
        <div className="pr-card-note">
          <Loading label="Checking DNS" height={96} />
        </div>
      ) : (
        <dl className="pr-kv-list">
          {AUTH_RECORDS.map((record) => {
            const row = worstRow(dns.rows, record);
            if (row === undefined) return null;
            const s = DNS_STATUS[row.status];
            // No DKIM key exists yet (the expected value is null): the next step is the wizard.
            const noKeys = record === 'DKIM' && row.expected === null;
            return (
              <div key={record} className="pr-kv" data-record={record}>
                <dt className="pr-kv__k">{record}</dt>
                <dd className="pr-kv__v">
                  {noKeys ? (
                    <Link asChild>
                      <RouterLink to="/admin/setup">
                        Generate keys <span aria-hidden="true">→</span>
                      </RouterLink>
                    </Link>
                  ) : (
                    <span className="pr-kv__reason" title={row.reason}>
                      {row.reason}
                    </span>
                  )}
                  <StatusDot tone={row.status === 'pending' ? 'idle' : s.tone} size="sm">
                    {s.label}
                  </StatusDot>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </Card>
  );
}

function OutboundQueue({ rows, limited, failed }: { rows: QueueRow[] | null; limited: boolean; failed: boolean }) {
  const headId = useId();
  return (
    <Card as="section" aria-labelledby={headId} className="pr-table-card" data-section="outbound-queue">
      <CardHead
        id={headId}
        title="Outbound queue"
        meta={rows === null ? null : queueMeta(rows, limited)}
        end={
          <Link asChild>
            <RouterLink to="/admin/queue">
              View queue <span aria-hidden="true">→</span>
            </RouterLink>
          </Link>
        }
      />
      {failed ? (
        <p className="pr-card-note">Could not load the queue just now.</p>
      ) : rows === null ? (
        <div className="pr-card-note">
          <Loading label="Loading the queue" height={96} />
        </div>
      ) : rows.length === 0 ? null : (
        <DataList aria-label="First recipients in the outbound queue" className="pr-card-list">
          {rows.slice(0, QUEUE_PREVIEW).map((r) => {
            const s = queueState(r.state);
            return (
              <DataListRow
                key={r.id}
                title={
                  <span className="pr-admin-mono" title={r.address}>
                    {r.address}
                  </span>
                }
                meta={
                  <>
                    <StatusDot tone={s.tone} size="sm">
                      {s.label}
                    </StatusDot>
                    <span className="pr-muted">
                      queued <RelativeTime iso={r.createdAt} />
                    </span>
                  </>
                }
              />
            );
          })}
        </DataList>
      )}
    </Card>
  );
}

/**
 * PST-REQ-127: tunnel, daemons, certificates, disk, queue, backup, drill and NTP — the header says in
 * one line whether anything needs you, four Stats answer the questions asked most, the Services list
 * has every check (tunnel and blocklist included, once each), and the side cards pull in DNS
 * authentication and the outbound queue from the endpoints their own screens use. Auto-refreshes
 * every 30 s while the tab is open.
 *
 * PST-T-17.1 (PST-REQ-194, PST-REQ-155): every list is a card with a head row, the status column
 * never wraps, service names are words, and a phone gets cards instead of a clipped table.
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
  const phone = useMediaQuery(PHONE_QUERY);

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
  const refresh = useCallback(() => {
    void load();
    void loadDns();
  }, [load, loadDns]);
  // X11: on a phone, Refresh is an icon in the context bar, not a full-width slab under the h1.
  const barAction = useMemo(() => <IconButton icon={<RefreshIcon />} label="Refresh" loading={refreshing} onClick={refresh} />, [refreshing, refresh]);
  const inBar = useContextBarAction(barAction);

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
              <span>
                · checked <RelativeTime iso={checkedAt.toISOString()} />
              </span>
            </span>
          )
        }
        actions={
          inBar ? undefined : (
            <Button variant="secondary" loading={refreshing} onClick={refresh}>
              Refresh
            </Button>
          )
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
              <Services tiles={tiles} phone={phone} />
            </div>
            <div className="pr-health__stack">
              <Deliverability dns={dns} dnsFailed={dnsFailed} />
              <OutboundQueue rows={queue?.rows ?? null} limited={queue?.limited ?? false} failed={queueFailed} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
