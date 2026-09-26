// PST-T-7.4 doneWhen (PST-REQ-125): "Rotation fixture never leaves a signature unverifiable."
//
// A whole quarter's rotation on a simulated clock, against a fake DNS that remembers when each TXT
// record was published and removed (the operator's Cloudflare edits). At every step a message is
// signed with exactly the keys loadSigningKeys picks, then verified by the real verifier — through
// the fake DNS as it stood at delivery time and as it stands 3 days later. Every verification must
// pass. Along the way: the switch is refused while the new TXT is missing or wrong, retirement never
// happens before 7 days, every step is audited and a repeated pass changes nothing.
import { createDkimVerifier, signMessage, type DkimDns } from '@postroom/auth-checks';
import { generateKek, type Kek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDkimKeys, loadSigningKeys } from '../../src/dkim.js';
import { dkimKeyStatus, rotateDkimKeys, type RotationEvent } from '../../src/dkim-rotation.js';

const baseUrl = process.env['DATABASE_URL'];
const DOMAIN = 'd3cloud.io';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** TXT records with a publish/remove history, queryable at any instant. */
class TimelineDns {
  private readonly history: { name: string; value: string; from: number; until: number }[] = [];

  publish(name: string, value: string, at: Date): void {
    this.history.push({ name: name.toLowerCase(), value, from: at.getTime(), until: Number.POSITIVE_INFINITY });
  }

  remove(name: string, at: Date): void {
    for (const r of this.history) if (r.name === name.toLowerCase() && r.until > at.getTime()) r.until = at.getTime();
  }

  at(when: Date): DkimDns {
    const t = when.getTime();
    return { txt: (name) => Promise.resolve(this.history.filter((r) => r.name === name.toLowerCase() && r.from <= t && t < r.until).map((r) => r.value)) };
  }
}

interface Sent {
  label: string;
  at: Date;
  selectors: string[];
  raw: Buffer;
}

describe.skipIf(baseUrl === undefined)('DKIM rotation never leaves a signature unverifiable (PST-T-7.4)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  const dns = new TimelineDns();
  const sent: Sent[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t74');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: DOMAIN });
    kek = generateKek();
  });

  afterAll(async () => {
    await t.drop();
  });

  async function send(label: string, at: Date): Promise<Sent> {
    const keys = await loadSigningKeys(db, kek, DOMAIN, at);
    if (keys === null) throw new Error(`no signing keys at ${label}`);
    const message = Buffer.from(
      `From: ops@${DOMAIN}\r\nTo: someone@gmail.com\r\nSubject: ${label}\r\nDate: ${at.toUTCString()}\r\nMessage-ID: <${String(sent.length)}@${DOMAIN}>\r\n\r\nSent ${label}.\r\n`,
      'latin1',
    );
    const signatures = await signMessage(message, { domain: DOMAIN, keys, now: at });
    const s = { label, at, selectors: keys.map((k) => k.selector), raw: Buffer.concat([...signatures.map((h) => Buffer.from(h, 'latin1')), message]) };
    sent.push(s);
    return s;
  }

  async function verifyAt(s: Sent, when: Date, where = dns): Promise<string[]> {
    const results = await createDkimVerifier({ dns: where.at(when), now: when }).verifyStream(s.raw);
    expect(results).toHaveLength(2);
    return results.map((r) => (r.result === 'pass' ? 'pass' : `${r.result} (${r.selector ?? '?'}): ${r.reasons.join('; ')}`));
  }

  async function rotate(at: Date): Promise<RotationEvent[]> {
    return rotateDkimKeys(db, kek, DOMAIN, { dns: dns.at(at), now: at });
  }

  function kinds(events: RotationEvent[]): string[] {
    return events.map((e) => `${e.algorithm}:${e.kind}`);
  }

  async function states(): Promise<Record<string, string>> {
    const rows = await dkimKeyStatus(db, DOMAIN);
    return Object.fromEntries(rows.map((r) => [r.selector, r.state]));
  }

  it('runs a full rotation, signing and verifying at every step', async () => {
    // Day 0: the domain's first keys, published by the operator before the first send.
    const t0 = new Date('2026-01-05T09:00:00Z');
    const first = await ensureDkimKeys(db, kek, DOMAIN, { now: t0 });
    for (const k of first) dns.publish(k.dnsName, k.dnsRecord, t0);
    const oldSelectors = first.map((k) => k.selector);
    expect(oldSelectors).toEqual(['pr202601e', 'pr202601r']);

    await send('before rotation', new Date('2026-02-01T12:00:00Z'));
    expect(kinds(await rotate(new Date('2026-04-04T09:00:00Z')))).toEqual(['ed25519-sha256:not-due', 'rsa-sha256:not-due']);

    // Rotation due: the successors are created pending. The old keys keep signing.
    const due = new Date('2026-04-05T09:00:00Z');
    const created = await rotate(due);
    expect(kinds(created)).toEqual(['ed25519-sha256:created-pending', 'rsa-sha256:created-pending']);
    const newSelectors = created.map((e) => e.selector ?? '');
    expect(newSelectors).toEqual(['pr202604e', 'pr202604r']);
    const s1 = await send('pending, not yet published', new Date(due.getTime() + HOUR));
    expect(s1.selectors).toEqual(oldSelectors);

    // Not in DNS yet: the switch is refused, however often we ask.
    for (let h = 2; h <= 26; h += 12) {
      const at = new Date(due.getTime() + h * HOUR);
      expect(kinds(await rotate(at))).toEqual(['ed25519-sha256:awaiting-dns', 'rsa-sha256:awaiting-dns']);
      expect((await send(`awaiting DNS +${String(h)}h`, at)).selectors).toEqual(oldSelectors);
    }

    // The operator publishes Ed25519 correctly and RSA with a stale (wrong) p=.
    const published = new Date(due.getTime() + 30 * HOUR);
    const [edNew, rsaNew] = created;
    if (edNew?.dnsName === undefined || edNew.dnsRecord === undefined || rsaNew?.dnsName === undefined || rsaNew.dnsRecord === undefined) throw new Error('no records');
    dns.publish(edNew.dnsName, edNew.dnsRecord, published);
    dns.publish(rsaNew.dnsName, first[0]?.dnsRecord.replace('k=ed25519', 'k=rsa') ?? '', published);
    expect((await send('published, before the next pass', new Date(published.getTime() + HOUR))).selectors).toEqual(oldSelectors);

    const firstSwitch = new Date(published.getTime() + 2 * HOUR);
    const pass1 = await rotate(firstSwitch);
    expect(kinds(pass1)).toEqual(['ed25519-sha256:switched', 'rsa-sha256:awaiting-dns']);
    expect(pass1[1]?.detail).toMatch(/does not carry this key's p= value/);
    expect((await send('ed25519 switched, rsa still old', new Date(firstSwitch.getTime() + HOUR))).selectors).toEqual([newSelectors[0], oldSelectors[1]]);

    // The operator fixes the RSA record; the next pass switches it too.
    const fixed = new Date(firstSwitch.getTime() + 3 * HOUR);
    dns.remove(rsaNew.dnsName, fixed);
    dns.publish(rsaNew.dnsName, rsaNew.dnsRecord, fixed);
    const secondSwitch = new Date(fixed.getTime() + HOUR);
    expect(kinds(await rotate(secondSwitch))).toEqual(['ed25519-sha256:not-due', 'rsa-sha256:switched']);
    expect((await send('both switched', new Date(secondSwitch.getTime() + 1000))).selectors).toEqual(newSelectors);
    expect(await states()).toMatchObject({ pr202601e: 'retiring', pr202601r: 'retiring', pr202604e: 'active', pr202604r: 'active' });

    // The overlap: a pass every 6 hours. Nothing is retired before its 7 days.
    const retiredAt: Record<string, Date> = {};
    const switchedAt: Record<string, Date> = { pr202601e: firstSwitch, pr202601r: secondSwitch };
    for (let at = firstSwitch.getTime() + 6 * HOUR; at <= secondSwitch.getTime() + 9 * DAY; at += 6 * HOUR) {
      const now = new Date(at);
      for (const e of await rotate(now)) {
        if (e.kind !== 'retired' || e.selector === undefined) continue;
        retiredAt[e.selector] = now;
        // The operator removes a retired key's TXT an hour after being told it may.
        if (e.dnsName !== undefined) dns.remove(e.dnsName, new Date(at + HOUR));
      }
      const st = await states();
      for (const [sel, sw] of Object.entries(switchedAt)) {
        if (at - sw.getTime() < 7 * DAY) expect(st[sel], `${sel} at ${now.toISOString()}`).toBe('retiring');
      }
      await send(`overlap ${now.toISOString()}`, new Date(at + 1000));
    }
    for (const [sel, sw] of Object.entries(switchedAt)) {
      expect(retiredAt[sel], sel).toBeDefined();
      expect((retiredAt[sel]?.getTime() ?? 0) - sw.getTime()).toBeGreaterThanOrEqual(7 * DAY);
      expect((retiredAt[sel]?.getTime() ?? 0) - sw.getTime()).toBeLessThan(7 * DAY + 6 * HOUR);
    }
    expect(await states()).toEqual({ pr202601e: 'retired', pr202601r: 'retired', pr202604e: 'active', pr202604r: 'active' });

    await send('after retirement, old TXT removed', new Date(secondSwitch.getTime() + 10 * DAY));

    // The fixture's claim: every message verifies when delivered and 3 days later.
    expect(sent.length).toBeGreaterThan(40);
    const failures: string[] = [];
    for (const s of sent) {
      for (const when of [s.at, new Date(s.at.getTime() + 3 * DAY)]) {
        for (const r of await verifyAt(s, when)) if (r !== 'pass') failures.push(`${s.label} @ ${when.toISOString()}: ${r}`);
      }
    }
    expect(failures).toEqual([]);

    // Control: the fixture can see a failure. Had the old TXT been removed at the switch, the last
    // message signed with the old key would not verify 3 days later.
    const early = new TimelineDns();
    for (const k of first) early.publish(k.dnsName, k.dnsRecord, t0);
    for (const k of first) early.remove(k.dnsName, secondSwitch);
    const lastOld = sent.filter((s) => s.selectors.includes('pr202601r')).at(-1);
    if (lastOld === undefined) throw new Error('no message signed with the old RSA key');
    expect((await verifyAt(lastOld, new Date(lastOld.at.getTime() + 3 * DAY), early)).some((r) => r !== 'pass')).toBe(true);
  });

  it('audits every step, and a repeated pass changes nothing', async () => {
    const actions = await db.auditEvent.groupBy({ by: ['action'], where: { entityType: 'dkim_key' }, _count: true });
    expect(Object.fromEntries(actions.map((a) => [a.action, a._count]))).toEqual({
      'dkim_key.create': 4,
      'dkim_key.activate': 2,
      'dkim_key.retiring': 2,
      'dkim_key.retire': 2,
    });
    const at = new Date('2026-05-01T00:00:00Z');
    const before = await db.auditEvent.count();
    expect(kinds(await rotate(at))).toEqual(['ed25519-sha256:not-due', 'rsa-sha256:not-due']);
    expect(kinds(await rotate(at))).toEqual(['ed25519-sha256:not-due', 'rsa-sha256:not-due']);
    expect(await db.auditEvent.count()).toBe(before);
  });

  it('the next quarter creates new dated selectors, and --force never skips the DNS check', async () => {
    const at = new Date('2026-07-15T00:00:00Z');
    const events = await rotateDkimKeys(db, kek, DOMAIN, { dns: dns.at(at), now: at, force: true });
    expect(events.map((e) => e.selector)).toEqual(['pr202607e', 'pr202607r']);
    const again = await rotateDkimKeys(db, kek, DOMAIN, { dns: dns.at(at), now: at, force: true });
    expect(kinds(again)).toEqual(['ed25519-sha256:awaiting-dns', 'rsa-sha256:awaiting-dns']);
    expect((await loadSigningKeys(db, kek, DOMAIN, at))?.map((k) => k.selector)).toEqual(['pr202604e', 'pr202604r']);
  });
});
