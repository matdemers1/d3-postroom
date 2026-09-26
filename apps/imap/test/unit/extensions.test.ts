// PST-T-3.3 unit tests: the LISTEN notifier's fan-out and reconnect (over a fake pg client), and
// CONDSTORE's enabling rules.
import { EventEmitter } from 'node:events';
import { parseCommand, type Command } from '@postroom/imap-proto';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../../src/capabilities.js';
import { enablesCondstore, withModseq } from '../../src/extensions/condstore.js';
import { createExtensions, NullMailboxNotifier } from '../../src/extensions/index.js';
import { MAILBOX_CHANNEL, PgMailboxNotifier, type ListenClient } from '../../src/extensions/notify.js';

class FakeClient extends EventEmitter implements ListenClient {
  queries: string[] = [];
  ended = false;
  constructor(private readonly failConnect: boolean) {
    super();
  }
  connect(): Promise<unknown> {
    return this.failConnect ? Promise.reject(new Error('connection refused')) : Promise.resolve();
  }
  query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    return Promise.resolve();
  }
  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
  notify(payload: string): void {
    this.emit('notification', { channel: MAILBOX_CHANNEL, payload });
  }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cmd(text: string): Command {
  const r = parseCommand(text, { utf8: false });
  if (!r.ok) throw new Error(r.message);
  return r.command;
}

describe('PgMailboxNotifier', () => {
  it('fans a notification out to that mailbox only, and resyncs everyone on (re)connect', async () => {
    const clients: FakeClient[] = [];
    const failures = [false, true, false];
    const n = new PgMailboxNotifier({
      connectionString: 'postgres://x',
      minBackoffMs: 1,
      createClient: () => {
        const c = new FakeClient(failures[clients.length] ?? false);
        clients.push(c);
        return c;
      },
    });
    const hits: string[] = [];
    const unsubA = n.subscribe('a', () => hits.push('a'));
    n.subscribe('b', () => hits.push('b'));
    await tick();
    expect(clients[0]?.queries).toEqual(['LISTEN postroom_mailbox']);
    expect(n.connected).toBe(true);
    // First connect wakes everyone (a session may have subscribed before the LISTEN was up).
    expect(hits.sort()).toEqual(['a', 'b']);
    hits.length = 0;

    clients[0]?.notify('a');
    expect(hits).toEqual(['a']);
    hits.length = 0;

    // The backend dies; the first reconnect fails; the second succeeds and resyncs everyone.
    clients[0]?.emit('error', new Error('terminating connection due to administrator command'));
    clients[0]?.emit('end');
    expect(n.connected).toBe(false);
    await tick(50);
    expect(clients).toHaveLength(3);
    expect(n.connected).toBe(true);
    expect(n.connects).toBe(2);
    expect(hits.sort()).toEqual(['a', 'b']);
    hits.length = 0;

    // A late event from the dead client is ignored.
    clients[0]?.notify('a');
    expect(hits).toEqual([]);
    clients[2]?.notify('a');
    expect(hits).toEqual(['a']);

    unsubA();
    hits.length = 0;
    clients[2]?.notify('a');
    expect(hits).toEqual([]);
    await n.close();
    expect(clients[2]?.ended).toBe(true);
  });
});

describe('CONDSTORE enabling (RFC 7162 §3.1)', () => {
  it('recognises the enabling commands', () => {
    for (const t of [
      'a SELECT INBOX (CONDSTORE)',
      'a STATUS INBOX (HIGHESTMODSEQ)',
      'a FETCH 1 (MODSEQ)',
      'a FETCH 1 (FLAGS) (CHANGEDSINCE 4)',
      'a SEARCH MODSEQ 3',
      'a SEARCH NOT (OR SEEN MODSEQ 3)',
      'a STORE 1 (UNCHANGEDSINCE 3) +FLAGS (\\Seen)',
    ]) {
      expect(enablesCondstore(cmd(t)), t).toBe(true);
    }
    for (const t of ['a SELECT INBOX', 'a FETCH 1 (FLAGS)', 'a SEARCH SEEN', 'a STORE 1 +FLAGS (\\Seen)', 'a STATUS INBOX (MESSAGES)']) {
      expect(enablesCondstore(cmd(t)), t).toBe(false);
    }
  });

  it('adds MODSEQ to FETCH with FLAGS once aware, and always with CHANGEDSINCE', () => {
    const f = cmd('a FETCH 1 FAST') as Extract<Command, { name: 'FETCH' }>;
    expect(withModseq(f, false)).toBe(f);
    expect(withModseq(f, true).items.map((i) => i.type)).toEqual(['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'MODSEQ']);
    const c = cmd('a FETCH 1 (UID) (CHANGEDSINCE 2)') as Extract<Command, { name: 'FETCH' }>;
    expect(withModseq(c, false).items.map((i) => i.type)).toEqual(['UID', 'MODSEQ']);
  });
});

describe('extension registry', () => {
  it('advertises IDLE, CONDSTORE and QRESYNC only after authentication and accepts them in ENABLE', () => {
    const r = new CapabilityRegistry(createExtensions({ notifier: new NullMailboxNotifier() }));
    const before = r.list({ secure: true, startTlsAvailable: false, authenticated: false });
    expect(before).not.toContain('IDLE');
    const after = r.list({ secure: true, startTlsAvailable: false, authenticated: true });
    expect(after.slice(-3)).toEqual(['IDLE', 'CONDSTORE', 'QRESYNC']);
    expect([...r.enableable()].sort()).toEqual(['CONDSTORE', 'IMAP4REV2', 'QRESYNC', 'UTF8=ACCEPT']);
    expect(r.handler('IDLE')).toBeDefined();
  });
});
