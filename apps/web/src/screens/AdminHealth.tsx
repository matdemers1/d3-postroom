import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardBody, CardTitle, EmptyState, Grid, Page, PageHeader } from '@d3cloud/ui';
import { api, type HealthTile, type HealthTileState } from '../api';
import { Loading, LoadFailed } from './states';

const REFRESH_MS = 30_000;

const when = (iso: string | null): string =>
  iso === null ? 'never' : new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const TONE_LABEL: Record<HealthTileState, { label: string; tone: 'neutral' | 'attention' | 'danger' }> = {
  ok: { label: 'OK', tone: 'neutral' },
  warn: { label: 'Warning', tone: 'attention' },
  down: { label: 'Down', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'attention' },
};

function Tile({ tile }: { tile: HealthTile }) {
  const { label, tone } = TONE_LABEL[tile.state];
  return (
    <Card as="li" data-tile-id={tile.id} data-tile-state={tile.state}>
      <CardBody>
        <CardTitle as="h2">{tile.label}</CardTitle>
        <p>
          <Badge tone={tone}>{label}</Badge>
        </p>
        <p>{tile.detail}</p>
        <p>Since {when(tile.since)}</p>
      </CardBody>
    </Card>
  );
}

/**
 * PST-REQ-127: tunnel, daemons, certificates, disk, queue, backup, drill and NTP, as one grid of
 * tiles that refreshes on its own — every incident this screen exists for is something nobody is
 * staring at when it starts. Auto-refreshes every 30 s while the tab is open.
 */
export function AdminHealth() {
  const [tiles, setTiles] = useState<HealthTile[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setTiles((await api.adminHealth()).tiles);
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught);
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => {
      void load();
    }, REFRESH_MS);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, [load]);

  return (
    <Page>
      <PageHeader
        title="Health"
        description="Tunnel, daemons, certificates, disk, the inbound queue, backups and the restore drill."
        actions={
          <Button variant="secondary" onClick={() => void load()}>
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
        <Grid as="ul" minItemWidth="sm" aria-label="Health tiles">
          {tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} />
          ))}
        </Grid>
      )}
    </Page>
  );
}
