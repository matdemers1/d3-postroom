// The ManageSieve wire format (RFC 5804 §4): the line reader's strings, literals, numbers and strict
// CRLF, and the server's response encoding.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { describeDaemon } from '../../src/daemon.js';
import { capabilityLines, CommandReader, encodeLiteral, encodeString, status, type ReaderEvent } from '../../src/protocol.js';
import { checkScript, invalidNameReason, SIEVE_EXTENSIONS } from '../../src/store.js';

function readAll(input: string | Buffer, reader = new CommandReader()): ReaderEvent[] {
  reader.push(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  const out: ReaderEvent[] = [];
  for (let ev = reader.next(); ev !== null; ev = reader.next()) out.push(ev);
  return out;
}

function show(ev: ReaderEvent): unknown {
  if (ev.type === 'error') return { error: ev.message, fatal: ev.fatal, ...(ev.code === undefined ? {} : { code: ev.code }) };
  return ev.tokens.map((t) => (t.kind === 'string' ? `${t.literal ? 'L' : 'Q'}:${t.value.toString('utf8')}` : t.kind === 'number' ? t.value : `A:${t.value}`));
}

describe('managesieve', () => {
  it('names itself', () => {
    expect(describeDaemon()).toBe('postroom managesieve');
  });

  it('listens on 4190 by default and trusts PROXY only from the edge peer', () => {
    const c = loadConfig({});
    expect(c.port).toBe(4190);
    expect(c.edgePeers).toEqual(['10.77.0.1']);
    expect(loadConfig({ MANAGESIEVE_PORT: '14190', EDGE_PEER_ADDRESS: '10.0.0.1, 10.0.0.2' })).toMatchObject({ port: 14190, edgePeers: ['10.0.0.1', '10.0.0.2'] });
  });
});

describe('CommandReader', () => {
  it('reads atoms (upper-cased), quoted strings and numbers', () => {
    expect(readAll('havespace "my script" 1234\r\n').map(show)).toEqual([['A:HAVESPACE', 'Q:my script', 1234]]);
    expect(readAll('NOOP "a \\"quoted\\" \\\\ tag"\r\n').map(show)).toEqual([['A:NOOP', 'Q:a "quoted" \\ tag']]);
  });

  it('reads {n+} and {n} literals, whatever octets they hold', () => {
    const script = 'require "fileinto";\r\nif true {\n  fileinto "x";\r\n}\r\n';
    const n = Buffer.byteLength(script);
    expect(readAll(`PUTSCRIPT "a" {${n}+}\r\n${script}\r\n`).map(show)).toEqual([['A:PUTSCRIPT', 'Q:a', `L:${script}`]]);
    expect(readAll(`CHECKSCRIPT {${n}}\r\n${script}\r\n`).map(show)).toEqual([['A:CHECKSCRIPT', `L:${script}`]]);
  });

  it('waits for the rest of a line or literal split across chunks', () => {
    const reader = new CommandReader();
    const whole = Buffer.from('PUTSCRIPT "s" {5+}\r\nkeep;\r\nLOGOUT\r\n');
    const events: ReaderEvent[] = [];
    for (let i = 0; i < whole.length; i++) {
      reader.push(whole.subarray(i, i + 1));
      for (let ev = reader.next(); ev !== null; ev = reader.next()) events.push(ev);
    }
    expect(events.map(show)).toEqual([['A:PUTSCRIPT', 'Q:s', 'L:keep;'], ['A:LOGOUT']]);
  });

  it('refuses a bare LF or a bare CR as a line end, and stays in step', () => {
    expect(readAll('NOOP\nLOGOUT\r\n').map(show)).toEqual([{ error: 'bare LF in a command line (lines end with CRLF)', fatal: false }, ['A:LOGOUT']]);
    expect(readAll('NOOP\rX\r\nLOGOUT\r\n').map(show)).toEqual([{ error: 'bare CR in a command line (lines end with CRLF)', fatal: false }, ['A:X'], ['A:LOGOUT']]);
  });

  it('refuses a quoted string with CR, LF or NUL, and unknown escapes', () => {
    expect(readAll('NOOP "a\0b"\r\nNOOP\r\n').map(show)).toEqual([{ error: 'a quoted string cannot contain CR, LF or NUL', fatal: false }, ['A:NOOP']]);
    expect(readAll('NOOP "a\\nb"\r\nNOOP\r\n').map(show)).toEqual([{ error: 'only \\" and \\\\ may be escaped in a quoted string', fatal: false }, ['A:NOOP']]);
  });

  it('discards a literal over the limit, reports QUOTA/MAXSIZE, and reads on', () => {
    const reader = new CommandReader({ maxLiteral: 10 });
    const events = readAll(`PUTSCRIPT "big" {20+}\r\n${'x'.repeat(20)}\r\nNOOP\r\n`, reader);
    expect(events.map(show)).toEqual([{ error: 'literal larger than 10 octets', fatal: false, code: 'QUOTA/MAXSIZE' }, ['A:NOOP']]);
  });

  it('discards an oversized literal that arrives in pieces', () => {
    const reader = new CommandReader({ maxLiteral: 10 });
    const events: ReaderEvent[] = [];
    const pump = (s: string) => {
      reader.push(Buffer.from(s));
      for (let ev = reader.next(); ev !== null; ev = reader.next()) events.push(ev);
    };
    pump('PUTSCRIPT "big" {30+}\r\n0123456789');
    pump('0123456789');
    pump('0123456789\r\nNO');
    pump('OP\r\n');
    expect(events.map(show)).toEqual([{ error: 'literal larger than 10 octets', fatal: false, code: 'QUOTA/MAXSIZE' }, ['A:NOOP']]);
  });

  it('closes on a literal past the hard limit or a line that never ends', () => {
    expect(readAll('PUTSCRIPT "x" {999999999+}\r\n', new CommandReader({ maxLiteral: 10, hardLiteralLimit: 100 })).map(show)).toEqual([
      { error: 'literal larger than 100 octets', fatal: true },
    ]);
    expect(readAll(`NOOP "${'a'.repeat(100)}`, new CommandReader({ maxLine: 50 })).map(show)).toEqual([{ error: 'line too long', fatal: true }]);
  });
});

describe('responses', () => {
  it('quotes when it can and escapes " and \\', () => {
    expect(encodeString('plain')).toBe('"plain"');
    expect(encodeString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(encodeString('two\r\nlines')).toBe('{10}\r\ntwo\r\nlines');
    expect(encodeLiteral(Buffer.from('keep;')).toString()).toBe('{5}\r\nkeep;');
  });

  it('writes OK/NO/BYE with response codes', () => {
    expect(status('OK')).toBe('OK\r\n');
    expect(status('NO', 'gone', 'NONEXISTENT')).toBe('NO (NONEXISTENT) "gone"\r\n');
    expect(status('OK', 'Done', { tag: 'x1' })).toBe('OK (TAG "x1") "Done"\r\n');
    expect(status('NO', 'too big', 'QUOTA/MAXSIZE')).toBe('NO (QUOTA/MAXSIZE) "too big"\r\n');
  });

  it('offers SASL PLAIN only over TLS, and STARTTLS only before it', () => {
    const base = { authenticated: false, sieveExtensions: SIEVE_EXTENSIONS, maxRedirects: 4 };
    const plain = capabilityLines({ ...base, secure: false, startTlsAvailable: true });
    expect(plain).toContain('"SASL" ""\r\n');
    expect(plain).toContain('"STARTTLS"\r\n');
    const secure = capabilityLines({ ...base, secure: true, startTlsAvailable: true });
    expect(secure).toContain('"SASL" "PLAIN"\r\n');
    expect(secure).not.toContain('STARTTLS');
    expect(secure).toContain('"VERSION" "1.0"\r\n');
    expect(secure).toContain('"IMPLEMENTATION" "Postroom ManageSieve"\r\n');
    expect(secure).toMatch(/"SIEVE" "[^"]*fileinto[^"]*vnd\.postroom\.bucket[^"]*"\r\n/);
    expect(capabilityLines({ ...base, secure: false, startTlsAvailable: false })).not.toContain('STARTTLS');
  });
});

describe('script checks', () => {
  it('names the line and column of a compile error', () => {
    expect(checkScript('require "fileinto";\nfileinto "a";\n')).toBeNull();
    const problem = checkScript('require "fileinto";\n\nfileinto "a"\nkeep;\n');
    expect(problem).not.toBeNull();
    expect(problem?.line).toBe(4);
    expect(problem?.message).toMatch(/^line 4, column \d+: /);
  });

  it('refuses empty, over-long and control-character names', () => {
    expect(invalidNameReason('Rules')).toBeNull();
    expect(invalidNameReason('Регулы ✓')).toBeNull();
    expect(invalidNameReason('')).not.toBeNull();
    expect(invalidNameReason('x'.repeat(129))).not.toBeNull();
    expect(invalidNameReason('a\tb')).not.toBeNull();
    expect(invalidNameReason('a\u2028b')).not.toBeNull();
  });
});
