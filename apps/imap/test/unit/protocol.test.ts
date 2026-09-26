// Pure pieces of the daemon: mailbox names and LIST, flags, capabilities, configuration.
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, coreCapabilities } from '../../src/capabilities.js';
import { loadConfig, MIN_IDLE_TIMEOUT_MS } from '../../src/config.js';
import { applyFlags, normalizeFlags, sameFlags } from '../../src/flags.js';
import { listMailboxes, lsubMailboxes } from '../../src/list.js';
import { canonicalName, invalidNameReason, listPattern, parentsOf, stripTrailingDelimiter } from '../../src/names.js';
import type { MailboxInfo } from '../../src/store.js';

function mb(name: string, extra: Partial<MailboxInfo> = {}): MailboxInfo {
  return { id: name, name, specialUse: null, uidvalidity: 1, uidnext: 1, highestModseq: 0n, subscribed: true, ...extra };
}

describe('mailbox names', () => {
  it('treats INBOX (and its children) case-insensitively', () => {
    expect(canonicalName('inbox')).toBe('INBOX');
    expect(canonicalName('InBoX/Receipts')).toBe('INBOX/Receipts');
    expect(canonicalName('Inboxes')).toBe('Inboxes');
  });

  it('refuses empty levels, wildcards and control characters', () => {
    expect(invalidNameReason('a//b')).not.toBeNull();
    expect(invalidNameReason('/a')).not.toBeNull();
    expect(invalidNameReason('a*')).not.toBeNull();
    expect(invalidNameReason('a\u0001')).not.toBeNull();
    expect(invalidNameReason('Entwürfe/Ärger')).toBeNull();
    expect(stripTrailingDelimiter('a/b/')).toBe('a/b');
    expect(parentsOf('a/b/c')).toEqual(['a', 'a/b']);
  });

  it('matches LIST patterns: * crosses levels, % does not, INBOX in any case', () => {
    expect(listPattern('', '*').test('a/b')).toBe(true);
    expect(listPattern('', '%').test('a/b')).toBe(false);
    expect(listPattern('', 'a/%').test('a/b')).toBe(true);
    expect(listPattern('a/', '%').test('a/b')).toBe(true);
    expect(listPattern('', 'inbox').test('INBOX')).toBe(true);
    expect(listPattern('', 'a.b').test('axb')).toBe(false);
  });
});

describe('LIST', () => {
  const all = [
    mb('INBOX', { specialUse: 'inbox' }),
    mb('Sent', { specialUse: 'sent' }),
    mb('Projects/2026/Q3', { subscribed: false }),
    mb('Projects/Old', { subscribed: true }),
  ];

  it('lists implied parents as \\Noselect and marks children and special use', () => {
    const lines = listMailboxes(all, { selection: null, reference: '', patterns: ['*'], returnOpts: null });
    expect(lines.map((l) => `${l.name} ${l.attributes.join(' ')}`)).toEqual([
      'INBOX \\HasNoChildren',
      'Projects \\Noselect \\HasChildren',
      'Projects/2026 \\Noselect \\HasChildren',
      'Projects/2026/Q3 \\HasNoChildren',
      'Projects/Old \\HasNoChildren',
      'Sent \\HasNoChildren \\Sent',
    ]);
    expect(listMailboxes(all, { selection: null, reference: '', patterns: ['%'], returnOpts: null }).map((l) => l.name)).toEqual(['INBOX', 'Projects', 'Sent']);
  });

  it('honours SUBSCRIBED, RECURSIVEMATCH and SPECIAL-USE selection', () => {
    const subscribed = listMailboxes(all, { selection: ['SUBSCRIBED'], reference: '', patterns: ['*'], returnOpts: null });
    expect(subscribed.map((l) => l.name)).toEqual(['INBOX', 'Projects/Old', 'Sent']);
    expect(subscribed[0]?.attributes).toContain('\\Subscribed');
    const recursive = listMailboxes(all, { selection: ['SUBSCRIBED', 'RECURSIVEMATCH'], reference: '', patterns: ['%'], returnOpts: null });
    expect(recursive.find((l) => l.name === 'Projects')?.childInfo).toBe(true);
    const special = listMailboxes(all, { selection: ['SPECIAL-USE'], reference: '', patterns: ['*'], returnOpts: null });
    expect(special.map((l) => l.name)).toEqual(['Sent']);
    expect(lsubMailboxes(all, '', '*').map((l) => l.name)).toEqual(['INBOX', 'Projects/Old', 'Sent']);
  });
});

describe('flags', () => {
  it('canonicalises system flags, drops \\Recent, dedupes keywords case-insensitively', () => {
    expect(normalizeFlags(['\\seen', '\\Recent', '$Label', '$label', '\\SEEN'])).toEqual(['\\Seen', '$Label']);
    expect(applyFlags(['\\Seen'], 'add', ['\\Flagged'])).toEqual(['\\Seen', '\\Flagged']);
    expect(applyFlags(['\\Seen', '$A'], 'remove', ['$a'])).toEqual(['\\Seen']);
    expect(applyFlags(['\\Seen'], 'set', ['\\Draft'])).toEqual(['\\Draft']);
    expect(sameFlags(['$A', '\\Seen'], ['\\Seen', '$a'])).toBe(true);
  });
});

describe('capabilities', () => {
  it('advertises LOGINDISABLED and STARTTLS before TLS, AUTH=PLAIN after it, the rest after login', () => {
    expect(coreCapabilities({ secure: false, startTlsAvailable: true, authenticated: false })).toEqual([
      'IMAP4rev1', 'IMAP4rev2', 'LITERAL-', 'SASL-IR', 'ID', 'ENABLE', 'STARTTLS', 'LOGINDISABLED',
    ]);
    expect(coreCapabilities({ secure: true, startTlsAvailable: true, authenticated: false })).toContain('AUTH=PLAIN');
    const after = coreCapabilities({ secure: true, startTlsAvailable: true, authenticated: true });
    expect(after).toEqual(expect.arrayContaining(['IMAP4rev2', 'UIDPLUS', 'MOVE', 'SPECIAL-USE', 'ESEARCH', 'BINARY']));
    expect(after).not.toContain('AUTH=PLAIN');
  });

  it('lets an extension add capabilities, ENABLE names and commands', () => {
    const registry = new CapabilityRegistry([
      {
        name: 'idle',
        capabilities: (s) => (s.authenticated ? ['IDLE'] : []),
        enables: ['CONDSTORE'],
        commands: { IDLE: () => Promise.resolve({ status: 'OK', text: 'IDLE terminated' }) },
      },
    ]);
    expect(registry.list({ secure: true, startTlsAvailable: false, authenticated: true })).toContain('IDLE');
    expect(registry.enableable().has('CONDSTORE')).toBe(true);
    expect(registry.handler('IDLE')).toBeDefined();
    expect(registry.handler('NOOP')).toBeUndefined();
  });
});

describe('config', () => {
  it('defaults to 993 + 143, and never idles out an authenticated client in under 30 minutes', () => {
    const c = loadConfig({});
    expect(c.imapsPort).toBe(993);
    expect(c.imapPort).toBe(143);
    expect(c.idleTimeoutMs).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(loadConfig({ IMAP_IDLE_TIMEOUT_MS: '1000' }).idleTimeoutMs).toBe(MIN_IDLE_TIMEOUT_MS);
    expect(loadConfig({ EDGE_PEER_ADDRESS: '10.0.0.1, 10.0.0.2' }).edgePeers).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(c.tlsCertFile).toBeUndefined();
  });
});
