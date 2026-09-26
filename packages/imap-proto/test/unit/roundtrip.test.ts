// The central parser property (PST-REQ-070): any valid command AST, formatted to the wire and fed
// through the reader at arbitrary chunk boundaries, parses back to the same AST — under IMAP4rev1
// (modified UTF-7 names) and rev2 (UTF-8 names), with synchronizing and non-synchronizing literals.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CommandReader, formatCommand, parseAppendPrefix, parseCommand, type Command } from '../../src/index.js';
import { chunked, command } from './arbitraries.js';

const modes = fc.record({ utf8: fc.boolean(), literalPlus: fc.boolean() });

function readAll(reader: CommandReader, chunks: readonly Buffer[], utf8: boolean): Command[] {
  const out: Command[] = [];
  let append: { prefix: Buffer; data: Buffer[] } | null = null;
  for (const c of chunks) {
    reader.push(c);
    for (let ev = reader.next(); ev; ev = reader.next()) {
      switch (ev.type) {
        case 'command': {
          const r = parseCommand(ev.bytes, { utf8 });
          if (!r.ok) throw new Error(`parse failed: ${r.message} in ${JSON.stringify(ev.bytes.toString('latin1'))}`);
          out.push(r.command);
          break;
        }
        case 'append-begin':
          append = { prefix: ev.prefix, data: [] };
          break;
        case 'append-data':
          append?.data.push(Buffer.from(ev.chunk));
          break;
        case 'append-end': {
          if (!append) throw new Error('append-end without append-begin');
          const r = parseAppendPrefix(append.prefix, { utf8 });
          if (!r.ok) throw new Error(`append prefix failed: ${r.message}`);
          const data = Buffer.concat(append.data);
          expect(data.length).toBe(r.size);
          out.push({
            tag: r.tag,
            name: 'APPEND',
            mailbox: r.mailbox,
            flags: r.flags,
            date: r.date,
            message: { size: r.size, binary: r.binary, data },
          });
          append = null;
          break;
        }
        case 'error':
          throw new Error(`reader error ${ev.error.code}: ${ev.error.message}`);
        case 'continue':
        case 'raw-line':
          break;
      }
    }
  }
  return out;
}

describe('command round trip (fast-check)', () => {
  it('format → parseCommand yields the same AST', () => {
    fc.assert(
      fc.property(command, modes, (cmd, o) => {
        const wire = formatCommand(cmd, o);
        const r = parseCommand(wire, { utf8: o.utf8 });
        if (!r.ok) throw new Error(`${r.message} @${r.position}: ${JSON.stringify(wire.toString('latin1'))}`);
        expect(r.command).toEqual(cmd);
      }),
      { numRuns: 3000 },
    );
  });

  it('format → reader at arbitrary chunk boundaries → parse yields the same ASTs', () => {
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 4 }), modes, fc.array(fc.nat(), { maxLength: 20 }), (cmds, o, cuts) => {
        const wire = Buffer.concat(cmds.flatMap((c) => [formatCommand(c, o), Buffer.from('\r\n')]));
        const reader = new CommandReader({ literalMode: 'literal-' });
        const got = readAll(reader, chunked(wire, cuts), o.utf8);
        expect(got).toEqual(cmds);
        expect(reader.bufferedBytes).toBe(0);
      }),
      { numRuns: 1500 },
    );
  });

  it('commands are case-insensitive', () => {
    fc.assert(
      fc.property(command, fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }), (cmd, flips) => {
        // Flip the case of keyword letters only: outside strings, literals, flags and mailbox atoms
        // the grammar is case-insensitive. We flip just the command name, which is always a keyword.
        const wire = formatCommand(cmd).toString('latin1');
        const sp = wire.indexOf(' ');
        const rest = wire.slice(sp + 1);
        const nameLen = cmd.name.length;
        const name = Array.from(rest.slice(0, nameLen)).map((ch, i) => (flips[i % 64] ? ch.toLowerCase() : ch)).join('');
        const r = parseCommand(Buffer.from(`${wire.slice(0, sp + 1)}${name}${rest.slice(nameLen)}`, 'latin1'));
        expect(r.ok && r.command).toEqual(cmd);
      }),
      { numRuns: 500 },
    );
  });
});
