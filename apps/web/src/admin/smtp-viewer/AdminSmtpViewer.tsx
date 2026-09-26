import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardBody, CardTitle, EmptyState, Page, PageHeader, Table, type TableColumn } from '@d3cloud/ui';
import { api, parseSmtpLiveBlock, type SmtpLiveLine, type SmtpTranscriptDetail, type SmtpTranscriptSummary } from '../../api';
import { Loading, LoadFailed } from '../../screens/states';

const when = (iso: string | null): string =>
  iso === null ? '—' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

/** At most this many live lines kept on screen; older ones scroll off (the stored transcript, not
 * this view, is what is kept forever — PST-REQ-118). */
const MAX_LIVE_LINES = 500;

function LiveLineRow({ line }: { line: SmtpLiveLine }) {
  return (
    <p data-live-dir={line.dir}>
      <Badge tone={line.dir === 'C' ? 'neutral' : 'attention'}>{line.dir === 'C' ? 'client' : 'server'}</Badge>{' '}
      <code>{line.line}</code>
    </p>
  );
}

/** The admin-only live SMTP viewer (PST-REQ-117): every session, line by line, credentials already
 * redacted server-side before this ever sees them. */
function LiveView() {
  const [lines, setLines] = useState<(SmtpLiveLine & { key: number })[]>([]);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const source = new EventSource('/api/admin/smtp/live');
    source.onopen = () => {
      setConnected(true);
    };
    source.onerror = () => {
      setConnected(false);
    };
    source.addEventListener('line', (ev) => {
      const parsed = parseSmtpLiveBlock(`event: line\ndata: ${(ev as MessageEvent<string>).data}`);
      if (parsed === null) return;
      seq.current += 1;
      setLines((prev) => [...prev.slice(-(MAX_LIVE_LINES - 1)), { ...parsed, key: seq.current }]);
    });
    return () => {
      source.close();
    };
  }, []);

  return (
    <Card>
      <CardBody>
        <CardTitle as="h2">Live</CardTitle>
        <p>
          <Badge tone={connected ? 'neutral' : 'danger'}>{connected ? 'Connected' : 'Disconnected'}</Badge>
        </p>
        {lines.length === 0 ? (
          <p>No lines yet — they appear here as sessions happen.</p>
        ) : (
          <div role="log" aria-label="Live SMTP session lines" style={{ maxHeight: '24rem', overflowY: 'auto' }}>
            {lines.map((l) => (
              <LiveLineRow key={l.key} line={l} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function columnsFor(onOpen: (row: SmtpTranscriptSummary) => void): TableColumn<SmtpTranscriptSummary>[] {
  return [
    { key: 'daemon', header: 'Daemon', cell: (t) => t.daemon },
    { key: 'clientIp', header: 'Client', cell: (t) => t.clientIp },
    { key: 'startedAt', header: 'Started', cell: (t) => when(t.startedAt) },
    { key: 'lineCount', header: 'Lines', cell: (t) => String(t.lineCount) },
    { key: 'compressedBytes', header: 'Compressed bytes', cell: (t) => String(t.compressedBytes) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      cell: (t) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onOpen(t);
          }}
        >
          View
        </Button>
      ),
    },
  ];
}

function TranscriptDetailView({ detail, onClose }: { detail: SmtpTranscriptDetail; onClose: () => void }) {
  return (
    <Card>
      <CardBody>
        <CardTitle as="h2">
          {detail.daemon} — {detail.sessionId}
        </CardTitle>
        <p>
          {detail.clientIp} · {when(detail.startedAt)} → {when(detail.endedAt)}
        </p>
        <div style={{ maxHeight: '28rem', overflowY: 'auto' }}>
          {detail.lines.map((l, i) => (
            <p key={i} data-line-dir={l.dir}>
              <Badge tone={l.dir === 'C' ? 'neutral' : 'attention'}>{l.dir === 'C' ? 'client' : 'server'}</Badge> <code>{l.line}</code>
            </p>
          ))}
        </div>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </CardBody>
    </Card>
  );
}

/**
 * PST-T-6.3: the transcript browser (every session, kept forever, compressed) and the live viewer
 * (PST-REQ-117) side by side — admin only (gated by app.ts's requireAdmin and, in this app, by
 * redirectFor's `/admin` prefix rule).
 */
export function AdminSmtpViewer() {
  const [transcripts, setTranscripts] = useState<SmtpTranscriptSummary[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<SmtpTranscriptDetail | null>(null);

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

  const open = useCallback(async (row: SmtpTranscriptSummary) => {
    setSelected(await api.adminSmtpTranscript(row.id));
  }, []);

  return (
    <Page>
      <PageHeader
        title="SMTP sessions"
        description="Every SMTP session's transcript, credentials redacted, kept forever — and the live feed as it happens."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      <LiveView />
      {selected !== null ? (
        <TranscriptDetailView
          detail={selected}
          onClose={() => {
            setSelected(null);
          }}
        />
      ) : loadError !== null ? (
        <LoadFailed error={loadError} what="transcripts" onRetry={() => void load()} />
      ) : transcripts === null ? (
        <Loading label="Loading transcripts" />
      ) : transcripts.length === 0 ? (
        <EmptyState kind="empty" heading="No transcripts yet" headingLevel={2}>
          They appear here once a session ends.
        </EmptyState>
      ) : (
        <Table
          caption="Transcripts"
          captionHidden
          columns={columnsFor((row) => {
            void open(row);
          })}
          rows={transcripts}
          rowKey={(t) => t.id}
          empty={<EmptyState kind="empty" heading="No transcripts" size="row" />}
        />
      )}
    </Page>
  );
}
