// PST-T-15.7 (PST-REQ-194): Admin › Health on the redesign canvas. The words and tones are pure
// (src/admin/health/model.ts); the layout rules — 44px table rows, StatusDot not Badge on Health,
// no invented "Run drill" — are held by a source scan so a later edit that undoes one fails here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HealthTile } from '../../src/api';
import {
  TILE_TONE,
  backupNotConfigured,
  certificateStat,
  durationShort,
  healthSummary,
  humanizeDetail,
  inboundQueueCounts,
  inboundQueueStat,
  lastRunFootnote,
  lastRunView,
  lastRunStat,
  queueMeta,
  queueState,
  relativeTime,
  serviceName,
  servicesMeta,
  sinceText,
  sortTiles,
  tileAction,
  tileDetail,
  BACKUP_RUNBOOK_URL,
} from '../../src/admin/health/model';

const SRC = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8');

const tile = (over: Partial<HealthTile> & Pick<HealthTile, 'id' | 'state'>): HealthTile => ({ label: over.id, detail: '', since: null, ...over });
const NOW = new Date('2026-09-29T15:00:00Z');

describe('tile tones (D-016)', () => {
  it('healthy is neutral, never a hue; degraded asks; down is danger; not checked is idle', () => {
    expect(TILE_TONE).toEqual({
      ok: { label: 'Healthy', tone: 'neutral' },
      warn: { label: 'Degraded', tone: 'attention' },
      down: { label: 'Down', tone: 'danger' },
      unknown: { label: 'Not checked', tone: 'idle' },
    });
  });
});

describe('healthSummary', () => {
  it('is neutral "All systems normal" when nothing is down or degraded, even with a check not yet run', () => {
    expect(healthSummary([tile({ id: 'a', state: 'ok' }), tile({ id: 'b', state: 'unknown' })])).toEqual({ tone: 'neutral', text: 'All systems normal' });
  });

  it('takes attention for a degraded check and danger for a down one, naming how many', () => {
    expect(healthSummary([tile({ id: 'a', state: 'ok' }), tile({ id: 'b', state: 'warn' })])).toEqual({ tone: 'attention', text: '1 check degraded' });
    expect(healthSummary([tile({ id: 'a', state: 'down' }), tile({ id: 'b', state: 'down' }), tile({ id: 'c', state: 'warn' })])).toEqual({
      tone: 'danger',
      text: '2 checks down, 1 degraded',
    });
  });

  it('is idle when nothing has been checked at all', () => {
    expect(healthSummary([tile({ id: 'a', state: 'unknown' })])).toEqual({ tone: 'idle', text: 'Nothing checked yet' });
  });
});

describe('servicesMeta', () => {
  it('counts worst first and leaves out zeros', () => {
    expect(servicesMeta([tile({ id: 'a', state: 'ok' }), tile({ id: 'b', state: 'ok' }), tile({ id: 'c', state: 'unknown' })])).toBe('2 healthy · 1 not checked');
    expect(servicesMeta([tile({ id: 'a', state: 'ok' }), tile({ id: 'b', state: 'down' })])).toBe('1 down · 1 healthy');
  });
});

describe('times', () => {
  it('relativeTime reads like the canvas: just now, minutes, hours, days, then a date', () => {
    expect(relativeTime('2026-09-29T14:59:40Z', NOW)).toBe('just now');
    expect(relativeTime('2026-09-29T14:58:00Z', NOW)).toBe('2 min ago');
    expect(relativeTime('2026-09-29T12:00:00Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-09-27T15:00:00Z', NOW)).toBe('2 d ago');
    expect(relativeTime('2026-09-01T15:00:00Z', NOW)).toMatch(/^on /);
  });

  it('durationShort keeps queue ages short and aligned', () => {
    expect(durationShort(14 * 60_000)).toBe('14m');
    expect(durationShort(62 * 60_000)).toBe('1h 02m');
    expect(durationShort((3 * 24 + 4) * 3_600_000)).toBe('3d 4h');
    expect(durationShort(-5)).toBe('0m');
  });

  it('sinceText says "ran" for a backup or drill and "since" for a monitor state', () => {
    expect(sinceText(tile({ id: 'backup', state: 'ok', since: '2026-09-29T12:00:00Z' }), NOW)).toBe('ran 3 h ago');
    expect(sinceText(tile({ id: 'tunnel', state: 'ok', since: '2026-09-27T15:00:00Z' }), NOW)).toBe('since 2 d');
    expect(sinceText(tile({ id: 'smtp-in', state: 'ok' }), NOW)).toBeNull();
  });
});

describe('Stats read only what the server sent', () => {
  it('parses the inbound-queue detail apps/api writes, and refuses anything else', () => {
    expect(inboundQueueCounts(tile({ id: 'queue', state: 'ok', detail: 'no dead jobs' }))).toEqual({ dead: 0, failed: 0 });
    expect(inboundQueueCounts(tile({ id: 'queue', state: 'down', detail: '2 dead job(s), 1 failed message(s)' }))).toEqual({ dead: 2, failed: 1 });
    expect(inboundQueueCounts(tile({ id: 'queue', state: 'down', detail: '1 dead job, 3 failed messages' }))).toEqual({ dead: 1, failed: 3 });
    expect(inboundQueueCounts(tile({ id: 'queue', state: 'ok', detail: 'No dead jobs' }))).toEqual({ dead: 0, failed: 0 });
    expect(inboundQueueCounts(tile({ id: 'queue', state: 'down', detail: 'something new' }))).toBeNull();
  });

  it('a last-run tile that never ran says Never; one that ran gives its time and day', () => {
    expect(lastRunStat(tile({ id: 'backup', state: 'unknown', detail: 'never run' }), NOW)).toEqual({ value: 'Never' });
    const ran = lastRunStat(tile({ id: 'backup', state: 'ok', since: new Date(NOW.getTime() - 60_000).toISOString() }), NOW);
    expect(ran.unit).toBe('today');
    expect(lastRunFootnote(tile({ id: 'backup', state: 'ok', detail: 'ok' }), 'backup')).toBe('Last backup succeeded');
    expect(lastRunFootnote(tile({ id: 'backup', state: 'down', detail: 'S3 refused' }), 'backup')).toBe('S3 refused');
  });

  it('certificates are days left, read from the monitor’s detail, or "—" — never a status word (PST-T-17.1)', () => {
    expect(certificateStat(tile({ id: 'cert-expiry', state: 'ok', detail: 'all certificates valid for at least 21 days' }))).toMatchObject({ value: '21+', unit: 'days left' });
    const failing = certificateStat(tile({ id: 'cert-expiry', state: 'down', detail: 'a.pem: expires in 3.6 days; b.pem: expires in 12.0 days' }));
    expect(failing).toMatchObject({ value: '3', unit: 'days left', status: { label: 'Down', tone: 'danger' } });
    expect(certificateStat(tile({ id: 'cert-expiry', state: 'down', detail: 'a.pem: expires in 0.4 days' }))).toMatchObject({ value: '0', unit: 'days left' });
    expect(certificateStat(tile({ id: 'cert-expiry', state: 'unknown', detail: 'Not yet checked' }))).toEqual({
      value: '—',
      status: { label: 'Not checked', tone: 'idle' },
      footnote: 'Not checked yet',
    });
    expect(certificateStat(tile({ id: 'cert-expiry', state: 'down', detail: 'a.pem: ENOENT' })).value).toBe('—');
    expect(certificateStat(undefined)).toMatchObject({ value: '—', footnote: 'Not reported' });
  });

  it('every Stat value is a number, a time or "—"; the inbound queue counts dead jobs', () => {
    expect(inboundQueueStat(tile({ id: 'queue', state: 'down', detail: '1 dead job, 1 failed message' }))).toEqual({
      value: '1',
      unit: 'dead job',
      status: { label: 'Down', tone: 'danger' },
      footnote: '1 failed message',
    });
    expect(inboundQueueStat(tile({ id: 'queue', state: 'ok', detail: 'something new' })).value).toBe('—');
    expect(inboundQueueStat(undefined).value).toBe('—');
  });

  it('a backup with no offsite bucket is "Local only" with an attention status, not a time over "Not checked"', () => {
    const skipped = tile({
      id: 'backup',
      state: 'unknown',
      since: new Date(NOW.getTime() - 60_000).toISOString(),
      detail: 'backups not configured (BACKUP_BUCKET not set): local dump only, nothing left this machine',
    });
    expect(backupNotConfigured(skipped)).toBe(true);
    expect(lastRunView(skipped, 'backup', NOW)).toEqual({
      value: 'Local only',
      status: { label: 'No offsite copy', tone: 'attention' },
      footnote: 'BACKUP_BUCKET not set · local dump ran 1 min ago',
    });
    const ran = lastRunView(tile({ id: 'drill', state: 'ok', detail: 'ok', since: new Date(NOW.getTime() - 60_000).toISOString() }), 'drill', NOW);
    expect(ran).toMatchObject({ unit: 'today', status: { label: 'Healthy', tone: 'neutral' }, footnote: 'Last drill succeeded' });
    expect(lastRunView(tile({ id: 'drill', state: 'unknown', detail: 'Never run' }), 'drill', NOW).value).toBe('Never');
  });
});

describe('outbound queue', () => {
  it('queued is neutral, deferred asks, bounced is danger', () => {
    expect(queueState('queued')).toEqual({ label: 'Queued', tone: 'neutral' });
    expect(queueState('deferred')).toEqual({ label: 'Deferred', tone: 'attention' });
    expect(queueState('bounced')).toEqual({ label: 'Bounced', tone: 'danger' });
    expect(queueState('cancelled')).toEqual({ label: 'Cancelled', tone: 'neutral' });
  });

  it('queueMeta counts what is waiting, and says when the list was cut off', () => {
    expect(queueMeta([], false)).toBe('Nothing queued');
    expect(queueMeta([{ state: 'queued' }, { state: 'deferred' }, { state: 'bounced' }], false)).toBe('3 in queue · 1 deferred · 1 bounced');
    expect(queueMeta([{ state: 'queued' }], true)).toBe('1+ in queue');
  });
});

describe('the Admin screens on the canvas (source scan)', () => {
  it('Health is StatusDot and Stat, never a Badge, and has no Run drill (no API triggers one)', () => {
    const health = read('screens/AdminHealth.tsx');
    expect(health).toContain('<StatGroup>');
    expect(health).toContain('<StatusDot');
    expect(health).not.toMatch(/<(Status)?Badge\b/);
    expect(health).not.toMatch(/>\s*Run drill\s*</);
    expect(health).toContain('to="/admin/queue"');
    expect(read('api.ts')).not.toMatch(/drill/i);
  });

  it('every admin table has 44px rows from admin.css', () => {
    const css = read('admin/admin.css');
    expect(css).toMatch(/\.pr-admin-table \.d3-tbl__td \{[^}]*box-sizing: border-box;[^}]*height: 44px;/);
    for (const screen of ['AdminHealth', 'AdminQueue', 'AdminDeliverability', 'AdminJobs', 'AdminSuppressions', 'AdminSessions', 'AdminDns']) {
      const src = read(`screens/${screen}.tsx`);
      expect(src, screen).toContain("import '../admin/admin.css';");
      const tables = src.match(/<Table\b/g)?.length ?? 0;
      const styled = src.match(/<Table\s+className="pr-admin-table|className="pr-admin-table[^"]*"\s*\/?>?|className="pr-admin-table/g)?.length ?? 0;
      expect(styled, screen).toBeGreaterThanOrEqual(tables);
      expect(src, screen).not.toContain('density="compact"');
    }
  });

  it('no admin screen draws its own shadow or a success hue', () => {
    for (const file of ['admin/admin.css', 'screens/AdminDeliverability.tsx', 'screens/AdminHealth.tsx']) {
      const text = read(file);
      expect(text, file).not.toContain('box-shadow');
      expect(text, file).not.toContain('--color-success');
    }
  });
});

describe('Health speaks plainly (PST-T-16.5, PST-DA-033)', () => {
  it('capitalises the first letter and pluralises "(s)" by the count', () => {
    expect(humanizeDetail('not yet checked')).toBe('Not yet checked');
    expect(humanizeDetail('7 dead job(s), 5 failed message(s)')).toBe('7 dead jobs, 5 failed messages');
    expect(humanizeDetail('1 dead job(s), 1 failed message(s)')).toBe('1 dead job, 1 failed message');
    expect(humanizeDetail('0 session(s), 0 bytes compressed (0 raw)')).toBe('0 sessions, 0 bytes compressed (0 raw)');
    expect(humanizeDetail('1 DKIM key(s) awaiting DNS beyond 3d')).toBe('1 DKIM key awaiting DNS beyond 3d');
    expect(humanizeDetail('ok')).toBe('OK');
    expect(humanizeDetail('expires in 3 days')).toBe('Expires in 3 days');
    expect(humanizeDetail('')).toBe('');
    for (const raw of ['3 dead job(s)', '1 session(s)', 'x']) expect(humanizeDetail(raw)).not.toContain('(s)');
  });

  it('maps raw errno reasons to sentences, whatever surrounds the code', () => {
    expect(humanizeDetail("EACCES: permission denied, open '/backups/x.dump'")).toMatch(/^Permission denied/);
    expect(humanizeDetail('EACCES')).not.toMatch(/EACCES/);
    expect(humanizeDetail("ENOENT: no such file or directory, open '/x'")).toBe('A file or folder Postroom needs wasn’t found.');
    expect(humanizeDetail('connect ECONNREFUSED 10.0.0.2:9000')).toBe('The connection was refused: nothing is listening there.');
    expect(humanizeDetail('read ETIMEDOUT')).toMatch(/timed out/);
    expect(humanizeDetail('write ENOSPC: no space left on device')).toBe('The disk is full.');
    expect(lastRunFootnote(tile({ id: 'backup', state: 'down', detail: 'EACCES: permission denied' }), 'backup')).toMatch(/^Permission denied/);
  });

  it('orders rows down, then degraded, then not checked, then healthy, keeping server order within a state', () => {
    const rows = [
      tile({ id: 'ok1', state: 'ok' }),
      tile({ id: 'unk1', state: 'unknown' }),
      tile({ id: 'down1', state: 'down' }),
      tile({ id: 'ok2', state: 'ok' }),
      tile({ id: 'warn1', state: 'warn' }),
      tile({ id: 'down2', state: 'down' }),
      tile({ id: 'unk2', state: 'unknown' }),
    ];
    expect(sortTiles(rows).map((t) => t.id)).toEqual(['down1', 'down2', 'warn1', 'unk1', 'unk2', 'ok1', 'ok2']);
    expect(rows[0]?.id).toBe('ok1');
  });

  it('links a failing Inbound queue to the dead jobs and a failing Backup or Drill to the backup runbook', () => {
    expect(tileAction(tile({ id: 'queue', state: 'down' }))).toEqual({ label: 'View dead jobs', href: '/admin/jobs?status=dead', external: false });
    expect(tileAction(tile({ id: 'backup', state: 'down' }))).toEqual({ label: 'Backup runbook', href: BACKUP_RUNBOOK_URL, external: true });
    expect(tileAction(tile({ id: 'drill', state: 'warn' }))?.href).toBe(BACKUP_RUNBOOK_URL);
    expect(BACKUP_RUNBOOK_URL).toBe('https://github.com/matdemers1/d3-postroom/blob/main/docs/runbooks/backups.md');
  });

  it('offers no link for a check that is fine, not checked, or has no fix screen; OK stays neutral', () => {
    expect(tileAction(tile({ id: 'queue', state: 'ok' }))).toBeNull();
    expect(tileAction(tile({ id: 'backup', state: 'unknown' }))).toBeNull();
    expect(tileAction(tile({ id: 'disk', state: 'down' }))).toBeNull();
    expect(TILE_TONE.ok.tone).toBe('neutral');
  });

  it('the screen sorts, humanises and opens the runbook in a new tab with rel noopener noreferrer', () => {
    const health = read('screens/AdminHealth.tsx');
    expect(health).toContain('sortTiles(tiles)');
    expect(health).toContain('tileDetail(tile)');
    expect(health).toContain('rel="noopener noreferrer"');
  });
});

describe('Health on the canvas (PST-T-17.1, admin critique 2.1)', () => {
  it('names the daemons in words and leaves the server’s own labels alone', () => {
    expect(serviceName({ id: 'smtp-in', label: 'smtp-in' })).toBe('SMTP inbound');
    expect(serviceName({ id: 'imap', label: 'imap' })).toBe('IMAP');
    expect(serviceName({ id: 'managesieve', label: 'managesieve' })).toBe('ManageSieve');
    expect(serviceName({ id: 'dav', label: 'dav' })).toBe('CalDAV / CardDAV');
    expect(serviceName({ id: 'queue', label: 'Inbound queue' })).toBe('Inbound queue');
    expect(serviceName({ id: 'newd', label: 'newd' })).toBe('Newd');
  });

  it('drops a detail that only restates the status, and humanises the rest', () => {
    expect(tileDetail({ state: 'warn', detail: 'reported degraded' })).toBeNull();
    expect(tileDetail({ state: 'unknown', detail: 'Not yet checked' })).toBeNull();
    expect(tileDetail({ state: 'ok', detail: 'reachable' })).toBeNull();
    expect(tileDetail({ state: 'ok', detail: 'ok' })).toBeNull();
    expect(tileDetail({ state: 'down', detail: 'HTTP 503' })).toBe('HTTP 503');
    expect(tileDetail({ state: 'down', detail: '2 dead job(s), 1 failed message(s)' })).toBe('2 dead jobs, 1 failed message');
    // "reachable" on a down tile is not a restatement, so it stays.
    expect(tileDetail({ state: 'down', detail: 'reachable' })).toBe('Reachable');
  });

  it('has no Edge card, no pr-admin-card, a 9rem Status column, and cards on a phone', () => {
    const health = read('screens/AdminHealth.tsx');
    expect(health).not.toMatch(/title="Edge"/);
    expect(health).not.toContain('pr-admin-card');
    expect(health).toMatch(/key: 'state', header: 'Status', align: 'end', width: '9rem'/);
    expect(health).toContain('useMediaQuery(PHONE_QUERY)');
    expect(health).toContain('<DataList aria-label="Services"');
    expect(health).toContain('className="pr-table-card"');
    expect(health).toContain('<RelativeTime');
  });
});

describe('Health, Queue and Deliverability share one list grammar (source scan)', () => {
  const screens = ['AdminHealth', 'AdminQueue', 'AdminDeliverability'];

  it('no column width is fr or minmax (admin critique X8), and pr-admin-card is gone', () => {
    for (const screen of screens) {
      const src = read(`screens/${screen}.tsx`);
      expect(src, screen).not.toMatch(/width: '[^']*(fr|minmax)[^']*'/);
      expect(src, screen).not.toContain('pr-admin-card');
    }
    expect(read('admin/admin.css')).not.toMatch(/\.pr-admin-card\b/);
  });

  it('every list is in a pr-table-card; no Badge, no stacked FormField filter, no local when()', () => {
    for (const screen of screens) {
      const src = read(`screens/${screen}.tsx`);
      expect(src, screen).toContain('pr-table-card');
      expect(src, screen).not.toMatch(/<Badge\b/);
      expect(src, screen).not.toMatch(/<FormField label="(Domain|State|Range|Search)"/);
      expect(src, screen).not.toMatch(/const when = /);
    }
  });

  it('renders a phone as DataList cards', () => {
    for (const screen of screens) {
      const src = read(`screens/${screen}.tsx`);
      expect(src, screen).toMatch(/useMediaQuery\((QUEUE_)?PHONE_QUERY\)/);
      expect(src, screen).toContain('<DataList');
    }
  });
});
