// PST-T-12.2 (PST-REQ-161): when the composer offers Sign / Encrypt and why not, which recipients
// lack a key, what the send carries, and how a refusal reads. The Keys screen's own rules too.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api';
import type { CryptoKeyJson } from '../../src/keys/api';
import { cryptoAvailability, cryptoRequest, formatFingerprint, isCryptoRefusal, keyActions, keyErrorText, keyStatus, keyStatusDot, recipientAddresses, sniffImport, sortKeys } from '../../src/keys/format';
import { sendErrorText } from '../../src/mail/compose';
import { GO_CHORDS, resolveGo, resolveKey, SHORTCUTS } from '../../src/mail/keys';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let n = 0;
const key = (extra: Partial<CryptoKeyJson>): CryptoKeyJson => ({
  id: `k${String(++n)}`,
  kind: 'pgp',
  owner: 'contact',
  address: 'alice@example.test',
  fingerprint: 'AAAA',
  algorithm: 'Ed25519',
  userIds: [],
  hasPrivate: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-09-26T00:00:00.000Z',
  ...extra,
});

const mine = key({ owner: 'own', address: 'me@d3cloud.io', hasPrivate: true });
const alice = key({ address: 'alice@example.test' });

describe('recipientAddresses', () => {
  it('reads To, Cc and Bcc, names and quoting included, lowercased and de-duplicated', () => {
    expect(recipientAddresses({ to: '"Doe, Jane" <Jane@Example.org>, bob@example.org', cc: 'jane@example.org', bcc: 'Hidden <h@example.org>' })).toEqual(['jane@example.org', 'bob@example.org', 'h@example.org']);
    expect(recipientAddresses({ to: '', cc: ' ', bcc: '' })).toEqual([]);
  });
});

describe('cryptoAvailability', () => {
  it('sign needs an own key with its private half; encrypt needs an own key and one per recipient', () => {
    const a = cryptoAvailability([mine, alice], 'pgp', ['alice@example.test']);
    expect(a.sign).toEqual({ available: true, reason: null });
    expect(a.encrypt).toEqual({ available: true, reason: null, missing: [] });
  });

  it('names the recipients without a key', () => {
    const a = cryptoAvailability([mine, alice], 'pgp', ['alice@example.test', 'bob@example.test', 'carol@example.test']);
    expect(a.encrypt.available).toBe(false);
    expect(a.encrypt.missing).toEqual(['bob@example.test', 'carol@example.test']);
    expect(a.encrypt.reason).toContain('bob@example.test, carol@example.test');
  });

  it('with no own key: neither, with a reason each', () => {
    const a = cryptoAvailability([alice], 'pgp', ['alice@example.test']);
    expect(a.sign.available).toBe(false);
    expect(a.sign.reason).toMatch(/no OpenPGP key of your own/);
    expect(a.encrypt.available).toBe(false);
    expect(a.encrypt.reason).toMatch(/encrypted to you/);
  });

  it('only keys of the chosen kind, not revoked, not expired, count', () => {
    const smimeMine = key({ kind: 'smime', owner: 'own', address: 'me@d3cloud.io', hasPrivate: true });
    expect(cryptoAvailability([smimeMine, alice], 'smime', ['alice@example.test']).encrypt.missing).toEqual(['alice@example.test']);
    const revoked = key({ address: 'alice@example.test', revokedAt: '2026-09-01T00:00:00.000Z' });
    expect(cryptoAvailability([mine, revoked], 'pgp', ['alice@example.test']).encrypt.missing).toEqual(['alice@example.test']);
    const expired = key({ address: 'alice@example.test', expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(cryptoAvailability([mine, expired], 'pgp', ['alice@example.test'], new Date('2026-09-26T00:00:00Z')).encrypt.available).toBe(false);
    expect(cryptoAvailability([key({ owner: 'own', address: 'me@d3cloud.io', hasPrivate: false })], 'pgp', []).sign.available).toBe(false);
  });
});

describe('cryptoRequest', () => {
  const ok = cryptoAvailability([mine, alice], 'pgp', ['alice@example.test']);
  const missing = cryptoAvailability([mine], 'pgp', ['alice@example.test']);
  it('carries what is ticked, of the chosen kind', () => {
    expect(cryptoRequest('pgp', false, false, ok)).toBeUndefined();
    expect(cryptoRequest('pgp', true, false, ok)).toEqual({ sign: 'pgp' });
    expect(cryptoRequest('smime', true, true, ok)).toEqual({ sign: 'smime', encrypt: 'smime' });
  });
  it('a ticked Encrypt is sent even when a key went missing: the server refuses, it is never sent in the clear', () => {
    expect(cryptoRequest('pgp', false, true, missing)).toEqual({ encrypt: 'pgp' });
  });
});

describe('refusals read as sentences', () => {
  it('names the recipients without a key, from the 409 body', () => {
    const e = new ApiError(409, 'recipient_keys_missing', { error: 'recipient_keys_missing', recipients: ['bob@example.test'] });
    expect(isCryptoRefusal(e)).toBe(true);
    expect(sendErrorText(e)).toContain('bob@example.test');
    expect(sendErrorText(new ApiError(409, 'signing_key_missing', {}))).toMatch(/no key of your own to sign/);
    expect(keyErrorText(new ApiError(400, 'bad_passphrase', { message: 'That passphrase does not unlock the key.' }))).toBe('That passphrase does not unlock the key.');
    expect(keyErrorText(new Error('network'))).toMatch(/didn’t answer/);
  });
});

describe('Keys screen helpers', () => {
  it('formats fingerprints in groups of four', () => {
    expect(formatFingerprint('5a715f1777c830019a2d')).toBe('5A71 5F17 77C8 3001 9A2D');
  });
  it('status: revoked beats expired beats active', () => {
    expect(keyStatus({ revokedAt: '2026-01-01T00:00:00Z', expiresAt: '2020-01-01T00:00:00Z' })).toBe('revoked');
    expect(keyStatus({ revokedAt: null, expiresAt: '2020-01-01T00:00:00Z' })).toBe('expired');
    expect(keyStatus({ revokedAt: null, expiresAt: null })).toBe('active');
  });
  it('sorts own keys first, then by address', () => {
    expect(sortKeys([key({ address: 'z@x.test' }), key({ owner: 'own', address: 'b@x.test' }), key({ address: 'a@x.test' })]).map((k) => `${k.owner}:${k.address}`)).toEqual(['own:b@x.test', 'contact:a@x.test', 'contact:z@x.test']);
  });
  it('recognises what was pasted', () => {
    expect(sniffImport('-----BEGIN PGP PUBLIC KEY BLOCK-----\n…')).toBe('pgp-public');
    expect(sniffImport('-----BEGIN PGP PRIVATE KEY BLOCK-----\n…')).toBe('pgp-secret');
    expect(sniffImport('-----BEGIN CERTIFICATE-----\n…')).toBe('certificate');
    expect(sniffImport('hello')).toBe('unknown');
  });
});

// PST-T-17.10 (PST-REQ-194): Encryption keys on the canvas.
describe('Encryption keys rows', () => {
  it('status is a dot and a word: Active neutral, Expired warning, Revoked idle — never danger', () => {
    expect(keyStatusDot('active')).toEqual({ label: 'Active', tone: 'neutral' });
    expect(keyStatusDot('expired')).toEqual({ label: 'Expired', tone: 'warning' });
    expect(keyStatusDot('revoked')).toEqual({ label: 'Revoked', tone: 'idle' });
  });

  it('your own key exports either half and revokes; it is never removed', () => {
    expect(keyActions(mine).map((a) => a.label)).toEqual(['Export public key', 'Export private key…', 'Revoke…']);
    expect(keyActions({ ...mine, hasPrivate: false }).map((a) => a.action)).toEqual(['export-public', 'revoke']);
    expect(keyActions({ ...mine, revokedAt: '2026-09-01T00:00:00.000Z' }).map((a) => a.action)).toEqual(['export-public', 'export-private']);
  });

  it('a contact’s key exports, is marked revoked, or is removed', () => {
    expect(keyActions(alice).map((a) => a.label)).toEqual(['Export key', 'Mark revoked…', 'Remove']);
    expect(keyActions({ ...alice, revokedAt: '2026-09-01T00:00:00.000Z' }).map((a) => a.action)).toEqual(['export-public', 'remove']);
  });
});

describe('the Encryption keys screen', () => {
  const source = readFileSync(join(import.meta.dirname, '../../src/keys/Keys.tsx'), 'utf8');

  it('is titled as its nav entry, centred, with no count when there are no keys', () => {
    expect(source).toContain('title="Encryption keys"');
    expect(source).toContain('<Page width="narrow" align="center">');
    expect(source).toContain('rows === null || rows.length === 0 ? {} : { count: rows.length');
  });

  it('has no standalone Generate or Import sections: the forms open in place inside their cards', () => {
    // Two cards, plus the 'Your keys' card a load failure is drawn in (PST-T-17.10: never page-level).
    expect(source.match(/<Section\b/g)).toHaveLength(3);
    expect(source).toContain('<LoadFailed error={loadError} what="keys" headingLevel={3} size="row"');
    expect(source).not.toContain('scrollIntoView');
    expect(source.match(/className="pr-setform pr-inline-form"/g)).toHaveLength(2);
    expect(source.match(/<FormActions className="pr-setform__actions">/g)).toHaveLength(2);
    // The textarea fills the field column like every other field.
    expect(source).toMatch(/<FormField label="Key or certificate" width="lg"/);
  });

  it('every empty state is a row inside its card; status is a StatusDot; times are RelativeTime; no row is red', () => {
    for (const m of source.matchAll(/<EmptyState\b[^>]*>/g)) expect(m[0]).toContain('size="row"');
    expect(source).toContain('<StatusDot size="sm" tone={dot.tone}>');
    expect(source).toContain('<RelativeTime iso={k.createdAt} />');
    expect(source).not.toMatch(/<Badge|danger-ghost|toLocaleDateString/);
  });
});

// PST-T-16.19 (PST-DA-026, PST-REQ-084): go-to chords, on every Shell route.
describe('go-to chords', () => {
  const press = (key: string, extra: Partial<Parameters<typeof resolveGo>[0]> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, editable: false, ...extra });

  it('g then i, s, d, c, p reach Inbox, Sent, Drafts, Calendar and Contacts by their URLs', () => {
    const paths: [string, string][] = [['i', '/mail/inbox'], ['s', '/mail/sent'], ['d', '/mail/drafts'], ['c', '/calendar'], ['p', '/contacts']];
    for (const [second, path] of paths) {
      const first = resolveGo(press('g'), null);
      expect(first).toEqual({ go: null, pending: 'g' });
      const done = resolveGo(press(second), first.pending);
      expect(done.go?.path, second).toBe(path);
      expect(done.pending).toBeNull();
    }
    expect(GO_CHORDS.map((c) => c.key)).toEqual(['i', 's', 'd', 'c', 'p']);
  });

  it('a second key that is not a chord clears the g and goes nowhere', () => {
    expect(resolveGo(press('j'), 'g')).toEqual({ go: null, pending: null });
  });

  it('is typing, not a chord, in a field or with a modifier — and the letters alone do nothing', () => {
    expect(resolveGo(press('g', { editable: true }), null)).toEqual({ go: null, pending: null });
    expect(resolveGo(press('s', { editable: true }), 'g')).toEqual({ go: null, pending: null });
    expect(resolveGo(press('s', { ctrlKey: true }), 'g')).toEqual({ go: null, pending: null });
    expect(resolveGo(press('g', { metaKey: true }), null)).toEqual({ go: null, pending: null });
    expect(resolveGo(press('s'), null)).toEqual({ go: null, pending: null });
  });

  it('MailView’s own resolver still takes only g then i, so the other chords cannot double-fire there', () => {
    const key = (k: string) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, editable: false, activatable: false });
    expect(resolveKey(key('i'), 'g').action).toBe('goInbox');
    for (const second of ['s', 'd', 'c', 'p']) expect(resolveKey(key(second), 'g')).toEqual({ action: null, pending: null });
    expect(SHORTCUTS.find((s) => s.action === 'goInbox')?.keys).toBe('g then i');
  });

  it('the Shell mounts the place palette and the chords on every route without a MailView', () => {
    const shell = readFileSync(join(import.meta.dirname, '../../src/screens/Shell.tsx'), 'utf8');
    expect(shell).toContain('<PlacePalette enabled={!isMailView} />');
    expect(shell).toContain('useGoChords(isMailView);');
  });
});
