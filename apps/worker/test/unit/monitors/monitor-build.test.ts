// PST-T-4.7 fix #5: the daemon must not reach the public internet unless configured — tunnel and
// ntp are both off by default, on only once TUNNEL_HEALTH_URL / NTP_SERVER are set.
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { buildMonitors } from '../../../src/monitors/index.js';

// Only backlog and backup-drill touch the db in buildMonitors' synchronous construction path; a
// bare object is enough since no query runs until a monitor's check() is actually invoked.
const db = {} as unknown as Db;

describe('buildMonitors defaults (PST-T-4.7 fix #5)', () => {
  it('excludes tunnel and ntp with no env configured', () => {
    const { monitors, ntp } = buildMonitors({ db, env: {}, backupsConfigured: false });
    expect(monitors.map((m) => m.name)).not.toContain('tunnel');
    expect(ntp).toBeNull();
  });

  it('includes tunnel and ntp once TUNNEL_HEALTH_URL and NTP_SERVER are set', () => {
    const { monitors, ntp } = buildMonitors({
      db,
      env: { TUNNEL_HEALTH_URL: 'https://mail.d3cloud.io/health', NTP_SERVER: 'time.cloudflare.com' },
      backupsConfigured: false,
    });
    expect(monitors.map((m) => m.name)).toContain('tunnel');
    expect(ntp).not.toBeNull();
  });

  it('always includes backlog, cert-expiry-disabled-without-files, disk, blocklist-disabled, and backup-drill', () => {
    const { monitors } = buildMonitors({ db, env: {}, backupsConfigured: false });
    const names = monitors.map((m) => m.name).sort();
    expect(names).toEqual(['backlog', 'backup-drill', 'disk']);
  });
});
