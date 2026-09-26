// PST-T-10.2: the import's pure parts — where a source folder lands, INTERNALDATE, UID sets, the
// pinned fingerprint, astring encoding, and reading FETCH/LIST responses.
import fc from 'fast-check';
import { parseResponse } from '@postroom/imap-proto';
import { describe, expect, it } from 'vitest';
import { astring, fetchItems, listEntry, normalizeFingerprint, parseInternalDate, targetFor, uidSet } from '../../src/import/index.js';

describe('import helpers', () => {
  it('parses RFC 9051 INTERNALDATE, with its zone, and refuses anything else', () => {
    expect(parseInternalDate('17-Jul-1996 02:44:25 -0700')?.toISOString()).toBe('1996-07-17T09:44:25.000Z');
    expect(parseInternalDate(' 3-Feb-2026 00:00:01 +0100')?.toISOString()).toBe('2026-02-02T23:00:01.000Z');
    expect(parseInternalDate('17-Foo-1996 02:44:25 -0700')).toBeNull();
    expect(parseInternalDate('1996-07-17T02:44:25Z')).toBeNull();
  });

  it('compresses UIDs into a sequence set that expands back to the same set', () => {
    expect(uidSet([5, 1, 2, 3, 9, 7, 8, 3])).toBe('1:3,5,7:9');
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 500 }), { maxLength: 60 }), (uids) => {
        const expanded = new Set<number>();
        for (const part of uidSet(uids).split(',').filter((p) => p !== '')) {
          const [a, b] = part.split(':').map(Number);
          for (let u = a ?? 0; u <= (b ?? a ?? 0); u++) expanded.add(u);
        }
        expect([...expanded].sort((x, y) => x - y)).toEqual([...new Set(uids)].sort((x, y) => x - y));
      }),
    );
  });

  it('maps folders: INBOX, special use by attribute, hierarchy re-joined with our delimiter, bad levels dropped', () => {
    const f = (display: string, delimiter: string | null, attributes: string[] = []) => targetFor({ wire: display, display, delimiter, attributes });
    expect(f('inbox', '/')).toEqual({ name: 'INBOX', specialUse: 'inbox' });
    expect(f('Sent Items', '/', ['\\HasNoChildren', '\\Sent'])).toEqual({ name: 'Sent', specialUse: 'sent' });
    expect(f('[Gmail]/Spam', '/', ['\\Junk'])).toEqual({ name: 'Junk', specialUse: 'junk' });
    expect(f('INBOX.Work.2026', '.')).toEqual({ name: 'INBOX/Work/2026', specialUse: null });
    expect(f('a/b.c', '.')).toEqual({ name: 'a_b/c', specialUse: null });
    expect(f('x/../y/./z', '/')).toEqual({ name: 'x/y/z', specialUse: null });
    expect(f('..', '/')).toEqual({ name: 'Imported', specialUse: null });
  });

  it('accepts a SHA-256 fingerprint in any common spelling, and nothing else', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizeFingerprint(hex)).toBe(hex.toUpperCase());
    expect(normalizeFingerprint(hex.match(/../g)?.join(':') ?? '')).toBe(hex.toUpperCase());
    expect(normalizeFingerprint('ab'.repeat(20))).toBeNull();
    expect(normalizeFingerprint('zz'.repeat(32))).toBeNull();
  });

  it('quotes a plain astring and sends anything else as a literal', () => {
    expect(astring('user@example.org')).toEqual({ kind: 'text', value: '"user@example.org"' });
    expect(astring('a"b\\c')).toEqual({ kind: 'text', value: '"a\\"b\\\\c"' });
    expect(astring('pässword').kind).toBe('literal');
    expect(astring('line\r\nbreak').kind).toBe('literal');
  });

  it('reads FETCH items in any order, and LIST entries with their attributes', () => {
    const r = parseResponse('* 3 FETCH (FLAGS (\\Seen $Forwarded) INTERNALDATE "17-Jul-1996 02:44:25 -0700" UID 42 BODY[] {5}\r\nhello)');
    const items = fetchItems(r);
    expect(items.uid).toBe(42);
    expect(items.flags).toEqual(['\\Seen', '$Forwarded']);
    expect(items.internalDate?.toISOString()).toBe('1996-07-17T09:44:25.000Z');
    expect(items.body?.toString()).toBe('hello');
    expect(listEntry(parseResponse('* LIST (\\HasNoChildren \\Sent) "/" "Sent Items"'))).toEqual({
      wire: 'Sent Items',
      display: 'Sent Items',
      delimiter: '/',
      attributes: ['\\HasNoChildren', '\\Sent'],
    });
    expect(listEntry(parseResponse('* LIST () "." "&ANw-bung"'))?.display).toBe('Übung');
  });
});
