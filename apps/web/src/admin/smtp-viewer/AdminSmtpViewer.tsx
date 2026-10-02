import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Button,
  Card,
  DataList,
  DataListRow,
  EmptyState,
  Modal,
  ModalClose,
  Page,
  PageHeader,
  SearchField,
  SegmentedControl,
  StatusDot,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { api, parseSmtpLiveBlock, type SmtpLiveLine, type SmtpTranscriptDetail, type SmtpTranscriptLine, type SmtpTranscriptSummary } from '../../api';
import { fullTime, RelativeTime, relativeTime } from '../../components/RelativeTime';
import { useFocusReturn } from '../../mail/focusReturn';
import { PHONE_QUERY, useMediaQuery } from '../../mail/useMedia';
import { Loading, LoadFailed } from '../../screens/states';
import {
  atBottom,
  clock,
  daemonCounts,
  daemonLabel,
  direction,
  duration,
  filterTranscripts,
  humanBytes,
  initialLiveFeed,
  liveCount,
  liveFeedReducer,
  liveStatus,
  MAX_LIVE_LINES,
  sessionCount,
  sessionTag,
  type DaemonFilter,
  type LiveConnection,
} from './model';
import '../admin.css';
import './smtp-viewer.css';

type LogLine = (SmtpLiveLine | SmtpTranscriptLine) & { key: number | string };

/** One log line: a mono row of time, (session), direction glyph and the text — never a pill. */
function LogRow({ line, live }: { line: LogLine; live: boolean }) {
  const dir = direction(line.dir);
  const session = 'sessionId' in line ? line.sessionId : null;
  return (
    <div className="pr-smtp-line" data-dir={line.dir} {...(live ? { 'data-live-dir': line.dir } : { 'data-line-dir': line.dir })}>
      <time className="pr-smtp-line__time" dateTime={line.at} title={fullTime(line.at)}>
        {clock(line.at)}
      </time>
      {live && session !== null ? (
        <span className="pr-smtp-line__sess" title={`Session ${session}`}>
          {sessionTag(session)}
        </span>
      ) : null}
      <span className="pr-smtp-line__dir" aria-hidden="true">
        {dir.glyph}
      </span>
      <span className="pr-smtp-line__text">
        <span className="pr-smtp-vh">{dir.word}: </span>
        {line.line}
      </span>
    </div>
  );
}

/** The admin-only live SMTP viewer (PST-REQ-117): every session, line by line, credentials already
 * redacted server-side before this ever sees them. Pause holds new lines (up to the cap, and says
 * when the oldest fell off); Resume flushes them in one step; Clear empties the view only (the
 * stored transcripts are untouched). The state is model.ts's liveFeedReducer. */
function LiveFeed() {
  const [feed, dispatch] = useReducer(liveFeedReducer<LogLine>, MAX_LIVE_LINES, initialLiveFeed<LogLine>);
  const [connection, setConnection] = useState<LiveConnection>('connecting');
  const [pinned, setPinned] = useState(true);
  const seq = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  const { lines, held, paused } = feed;

  useEffect(() => {
    const source = new EventSource('/api/admin/smtp/live');
    source.onopen = () => {
      setConnection('open');
    };
    source.onerror = () => {
      // The browser retries on its own unless the server refused outright (CLOSED).
      setConnection(source.readyState === EventSource.CLOSED ? 'closed' : 'retrying');
    };
    source.addEventListener('line', (ev) => {
      const parsed = parseSmtpLiveBlock(`event: line\ndata: ${(ev as MessageEvent<string>).data}`);
      if (parsed === null) return;
      seq.current += 1;
      // Paused or not is the reducer's call, made against the state it holds — never a stale copy.
      dispatch({ type: 'line', line: { ...parsed, key: seq.current } });
    });
    return () => {
      source.close();
    };
  }, []);

  // New lines follow the bottom only while the reader is there; scrolled up, the view stays put.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el !== null && pinned) el.scrollTop = el.scrollHeight;
  }, [lines, pinned]);

  const status = liveStatus(connection, paused);

  return (
    <Card as="section" className="pr-table-card pr-smtp-live" aria-labelledby="pr-smtp-live-title">
      <div className="pr-table-toolbar">
        <div className="pr-smtp-head">
          <h2 id="pr-smtp-live-title" className="pr-smtp-title">
            Live feed
          </h2>
          <StatusDot size="sm" tone={status.tone} data-testid="smtp-live-status">
            {status.word}
          </StatusDot>
        </div>
        <div className="pr-table-toolbar__end">
          <span className="pr-smtp-count">{liveCount(feed)}</span>
          <span className="pr-smtp-actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                dispatch({ type: paused ? 'resume' : 'pause' });
              }}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={lines.length === 0 && held.length === 0}
              onClick={() => {
                dispatch({ type: 'clear' });
                setPinned(true);
              }}
            >
              Clear
            </Button>
          </span>
        </div>
      </div>
      {lines.length === 0 ? (
        <div className="pr-smtp-body">
          <EmptyState kind="empty" size="inline" heading={paused ? 'Paused' : 'Waiting for the next SMTP session'} headingLevel={3}>
            {paused ? 'New lines are held until you resume.' : 'Lines appear here as they happen, credentials already redacted.'}
          </EmptyState>
        </div>
      ) : (
        <div className="pr-smtp-logwrap">
          <div
            ref={logRef}
            role="log"
            aria-label="Live SMTP session lines"
            tabIndex={0}
            className="pr-smtp-log pr-smtp-log--live pr-smtp-log--sessions"
            onScroll={(e) => {
              const el = e.currentTarget;
              setPinned(atBottom(el.scrollTop, el.clientHeight, el.scrollHeight));
            }}
          >
            {lines.map((l) => (
              <LogRow key={l.key} line={l} live />
            ))}
          </div>
          {/* Floats on the pane, outside the log region, so it never crowds the toolbar. */}
          {pinned ? null : (
            <Button
              size="sm"
              variant="secondary"
              className="pr-smtp-jump"
              onClick={() => {
                setPinned(true);
              }}
            >
              Jump to latest
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function viewLabel(t: SmtpTranscriptSummary): string {
  return `View transcript: ${t.clientIp}, ${relativeTime(t.startedAt)}`;
}

function columnsFor(onOpen: (row: SmtpTranscriptSummary, opener: HTMLElement) => void): TableColumn<SmtpTranscriptSummary>[] {
  return [
    { key: 'startedAt', header: 'Started', width: '8rem', cell: (t) => <RelativeTime iso={t.startedAt} /> },
    { key: 'daemon', header: 'Daemon', width: '8rem', cell: (t) => daemonLabel(t.daemon) },
    { key: 'clientIp', header: 'Client', cell: (t) => <span className="pr-mono">{t.clientIp}</span> },
    { key: 'lineCount', header: 'Lines', width: '6rem', numeric: true, align: 'end', cell: (t) => String(t.lineCount) },
    {
      key: 'compressedBytes',
      header: 'Size',
      width: '6rem',
      numeric: true,
      align: 'end',
      cell: (t) => <span title={`${String(t.compressedBytes)} bytes compressed, ${String(t.rawBytes)} raw`}>{humanBytes(t.compressedBytes)}</span>,
    },
    {
      key: 'actions',
      header: <span className="pr-smtp-vh">Actions</span>,
      width: '6rem',
      align: 'end',
      cell: (t) => (
        <Button
          size="sm"
          variant="secondary"
          aria-label={viewLabel(t)}
          onClick={(e) => {
            onOpen(t, e.currentTarget);
          }}
        >
          View
        </Button>
      ),
    },
  ];
}

/** One stored session, in the end-edge drawer the queue and Inspect use: the list stays put behind it.
 * `row` outlives `open`, so the drawer keeps its content while it animates out. */
function TranscriptDrawer({ open, row, onClose }: { open: boolean; row: SmtpTranscriptSummary | null; onClose: () => void }) {
  const [detail, setDetail] = useState<SmtpTranscriptDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const id = row?.id ?? null;

  useEffect(() => {
    if (id === null) return;
    let live = true;
    setDetail(null);
    setError(null);
    api
      .adminSmtpTranscript(id)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught);
      });
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const lasted = row === null ? null : duration(row.startedAt, row.endedAt);
  return (
    <Modal
      open={open && row !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Session transcript"
      description={row === null ? '' : <span className="pr-mono">{row.clientIp}</span>}
      size="lg"
      className="pr-inspect"
      footer={
        <ModalClose>
          <Button type="button">Close</Button>
        </ModalClose>
      }
    >
      {row === null ? null : (
        <div className="pr-smtp-drawer">
          <p className="pr-smtp-facts">
            <span>{daemonLabel(row.daemon)}</span>
            <span>
              Started <RelativeTime iso={row.startedAt} />
            </span>
            <span>{lasted === null ? 'Still open' : `Lasted ${lasted}`}</span>
            <span>
              {String(row.lineCount)} {row.lineCount === 1 ? 'line' : 'lines'} · {humanBytes(row.compressedBytes)}
            </span>
            <span className="pr-mono" title="Session id">
              {row.sessionId}
            </span>
          </p>
          {error !== null ? (
            <LoadFailed
              error={error}
              what="this transcript"
              headingLevel={3}
              size="inline"
              onRetry={() => {
                setAttempt((n) => n + 1);
              }}
            />
          ) : detail === null || detail.id !== row.id ? (
            <Loading label="Loading the transcript" />
          ) : detail.lines.length === 0 ? (
            <EmptyState kind="empty" size="inline" heading="No lines recorded" headingLevel={3} />
          ) : (
            <div className="pr-smtp-log pr-smtp-log--framed" role="region" aria-label="Transcript lines">
              {detail.lines.map((l, i) => (
                <LogRow key={i} line={{ ...l, key: i }} live={false} />
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * PST-T-6.3: the transcript browser (every session, kept forever, compressed) and the live viewer
 * (PST-REQ-117) side by side — admin only (gated by app.ts's requireAdmin and, in this app, by
 * redirectFor's `/admin` prefix rule).
 *
 * PST-T-17.13 (PST-REQ-194, PST-REQ-155): on the canvas grammar — a page header, then two cards,
 * each opened by a toolbar row; status is a dot and a word; a session opens in a drawer so the list
 * stays; a phone gets cards instead of the table.
 */
export function AdminSmtpViewer() {
  const [transcripts, setTranscripts] = useState<SmtpTranscriptSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // The drawer's row stays set after it closes (its exit animation still shows it); `drawerOpen` is
  // what opens and closes it. The controlled Modal has no trigger, so focus goes back to the View
  // button that opened it by hand (PST-T-14.6's useFocusReturn), in the table and on a phone card.
  const [selected, setSelected] = useState<SmtpTranscriptSummary | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const returnTo = useFocusReturn(drawerOpen);
  const openTranscript = useCallback(
    (row: SmtpTranscriptSummary, opener: HTMLElement) => {
      returnTo.current = opener;
      setSelected(row);
      setDrawerOpen(true);
    },
    [returnTo],
  );
  const [daemon, setDaemon] = useState<DaemonFilter>('all');
  const [query, setQuery] = useState('');
  const phone = useMediaQuery(PHONE_QUERY);

  const load = useCallback(async () => {
    try {
      setTranscripts((await api.adminSmtpTranscripts({ limit: 100 })).transcripts);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => (transcripts === null ? null : filterTranscripts(transcripts, daemon, query)), [transcripts, daemon, query]);
  const counts = useMemo(() => daemonCounts(transcripts ?? []), [transcripts]);
  const columns = useMemo(
    () =>
      columnsFor((row, opener) => {
        openTranscript(row, opener);
      }),
    [openTranscript],
  );
  const filtered = daemon !== 'all' || query.trim() !== '';
  const emptyList = filtered ? (
    <EmptyState kind="no-results" size="inline" heading="No sessions match" headingLevel={3}>
      Try another client IP or daemon.
    </EmptyState>
  ) : (
    <EmptyState kind="empty" size="inline" heading="No sessions recorded yet" headingLevel={3}>
      Every session is kept, compressed, once it ends.
    </EmptyState>
  );

  return (
    <Page>
      <PageHeader
        title="Live SMTP"
        description="Every SMTP session, live and kept, credentials redacted."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Reload sessions
          </Button>
        }
      />
      <div className="pr-smtp">
        <LiveFeed />
        <Card as="section" className="pr-table-card" aria-labelledby="pr-smtp-sessions-title">
          <div className="pr-table-toolbar">
            <div className="pr-smtp-head">
              <h2 id="pr-smtp-sessions-title" className="pr-smtp-title">
                Sessions
              </h2>
              <SearchField
                className="pr-smtp-search"
                aria-label="Filter sessions by client IP or session id"
                placeholder="Client IP or session id"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
              />
              <SegmentedControl
                aria-label="Daemon"
                size="md"
                value={daemon}
                onValueChange={(v) => {
                  setDaemon(v === 'smtp-in' || v === 'submission' ? v : 'all');
                }}
                items={[
                  { value: 'all', label: 'All', count: counts.all, countLabel: 'sessions' },
                  { value: 'smtp-in', label: 'Inbound', count: counts['smtp-in'], countLabel: 'sessions' },
                  { value: 'submission', label: 'Submission', count: counts.submission, countLabel: 'sessions' },
                ]}
              />
            </div>
            {transcripts === null || shown === null ? null : (
              <div className="pr-table-toolbar__end">
                <span className="pr-smtp-count">{sessionCount(shown.length, transcripts.length)}</span>
              </div>
            )}
          </div>
          {loadError !== null ? (
            <div className="pr-smtp-body">
              <LoadFailed error={loadError} what="sessions" headingLevel={3} size="inline" onRetry={() => void load()} />
            </div>
          ) : shown === null ? (
            <div className="pr-smtp-body">
              <Loading label="Loading sessions" />
            </div>
          ) : shown.length === 0 ? (
            <div className="pr-smtp-body">{emptyList}</div>
          ) : phone ? (
            <DataList aria-label="Sessions">
              {shown.map((t) => (
                <DataListRow
                  key={t.id}
                  title={<span className="pr-mono">{t.clientIp}</span>}
                  description={`${daemonLabel(t.daemon)} · ${String(t.lineCount)} ${t.lineCount === 1 ? 'line' : 'lines'} · ${humanBytes(t.compressedBytes)}`}
                  meta={<RelativeTime iso={t.startedAt} />}
                  truncate={false}
                  actions={
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={viewLabel(t)}
                      onClick={(e) => {
                        openTranscript(t, e.currentTarget);
                      }}
                    >
                      View
                    </Button>
                  }
                />
              ))}
            </DataList>
          ) : (
            <Table
              className="pr-admin-table pr-admin-table--fixed"
              caption="Sessions"
              captionHidden
              columns={columns}
              rows={shown}
              rowKey={(t) => t.id}
              empty={emptyList}
            />
          )}
        </Card>
      </div>
      <TranscriptDrawer
        open={drawerOpen}
        row={selected}
        onClose={() => {
          setDrawerOpen(false);
        }}
      />
    </Page>
  );
}
