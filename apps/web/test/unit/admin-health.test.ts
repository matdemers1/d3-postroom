// PST-T-15.7 (PST-REQ-194): Admin › Health on the redesign canvas. The words and tones are pure
// (src/admin/health/model.ts); the layout rules — 44px table rows, StatusDot not Badge on Health,
// no invented "Run drill" — are held by a source scan so a later edit that undoes one fails here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HealthTile } from '../../src/api';
import {
  TILE_TONE,
  certificateValue,
  durationShort,
  healthSummary,
  inboundQueueCounts,
  lastRunFootnote,
  lastRunStat,
  queueMeta,
  queueState,
  relativeTime,
  servicesMeta,
  sinceText,
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
    expect(inboundQueueCounts(tile({ id: 'queue', state: 'down', detail: 'something new' }))).toBeNull();
  });

  it('a last-run tile that never ran says Never; one that ran gives its time and day', () => {
    expect(lastRunStat(tile({ id: 'backup', state: 'unknown', detail: 'never run' }), NOW)).toEqual({ value: 'Never' });
    const ran = lastRunStat(tile({ id: 'backup', state: 'ok', since: new Date(NOW.getTime() - 60_000).toISOString() }), NOW);
    expect(ran.unit).toBe('today');
    expect(lastRunFootnote(tile({ id: 'backup', state: 'ok', detail: 'ok' }), 'backup')).toBe('Last backup succeeded');
    expect(lastRunFootnote(tile({ id: 'backup', state: 'down', detail: 'S3 refused' }), 'backup')).toBe('S3 refused');
  });

  it('certificates are one word; the detail carries the numbers', () => {
    expect(certificateValue(tile({ id: 'cert-expiry', state: 'ok' }))).toBe('Valid');
    expect(certificateValue(tile({ id: 'cert-expiry', state: 'down' }))).toBe('Failing');
    expect(certificateValue(tile({ id: 'cert-expiry', state: 'unknown' }))).toBe('Not checked');
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
