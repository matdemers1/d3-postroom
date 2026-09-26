// mboxrd composition and quoting (PST-T-10.1): round-trips a folder containing a line starting
// with "From " and one already quoted ">From ", CRLF-terminated as blobstore content always is.
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { mboxEntry, mboxFolder, parseMbox, quoteFromLine, toAsctime, unquoteFromLine } from '../../../src/export/mbox.js';

async function drain(gen: AsyncGenerator<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return Buffer.concat(chunks).toString('latin1');
}

describe('toAsctime', () => {
  it('formats like C asctime, UTC, single-digit day space-padded', () => {
    expect(toAsctime(new Date(Date.UTC(1970, 0, 1, 0, 0, 0)))).toBe('Thu Jan  1 00:00:00 1970');
    expect(toAsctime(new Date(Date.UTC(2026, 8, 25, 13, 5, 9)))).toBe('Fri Sep 25 13:05:09 2026');
  });
});

describe('quoteFromLine / unquoteFromLine', () => {
  it('quotes a line starting with "From " and nothing else', () => {
    expect(quoteFromLine('From attacker@example.com forged')).toBe('>From attacker@example.com forged');
    expect(quoteFromLine('Subject: hello')).toBe('Subject: hello');
    expect(quoteFromLine('Formless')).toBe('Formless');
  });

  it('quotes an already-quoted line one level deeper, and unquotes back', () => {
    const once = quoteFromLine('From x y');
    const twice = quoteFromLine(once);
    expect(twice).toBe('>>From x y');
    expect(unquoteFromLine(twice)).toBe(once);
    expect(unquoteFromLine(once)).toBe('From x y');
  });

  it('leaves an unrelated ">" line alone', () => {
    expect(unquoteFromLine('>quoted reply, not From')).toBe('>quoted reply, not From');
  });
});

describe('mboxEntry / mboxFolder / parseMbox round-trip', () => {
  it('round-trips a message with a "From " line and an already-quoted ">From " line', async () => {
    const raw = ['Subject: test', 'From the mailing list', '>From nested quote', 'plain line', ''].join('\r\n');
    const date = new Date(Date.UTC(2026, 8, 25, 12, 0, 0));
    const text = await drain(mboxEntry({ envelopeFrom: 'alice@example.org', date, raw: Readable.from([Buffer.from(raw, 'utf8')]) }));

    expect(text.startsWith(`From alice@example.org ${toAsctime(date)}\n`)).toBe(true);
    // The "From " line is quoted; the already-quoted line gained one more '>'.
    expect(text).toContain('\n>From the mailing list\n');
    expect(text).toContain('\n>>From nested quote\n');
    expect(text).not.toMatch(/\r/); // CRLF -> LF throughout

    const [entry] = parseMbox(text);
    expect(entry?.envelopeFrom).toBe('alice@example.org');
    const expectedBody = raw.replace(/\r\n/g, '\n');
    expect(entry?.body).toBe(expectedBody.endsWith('\n') ? expectedBody : `${expectedBody}\n`);
  });

  it('round-trips several messages in one folder, in order, non-ASCII names carried by the caller', async () => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    function messages() {
      return (async function* () {
        yield { envelopeFrom: 'a@example.org', date, raw: Readable.from([Buffer.from('Subject: one\r\n\r\nbody one\r\n')]) };
        await Promise.resolve();
        yield { envelopeFrom: 'b@example.org', date, raw: Readable.from([Buffer.from('Subject: two\r\n\r\nFrom inside body two\r\n')]) };
      })();
    }
    const text = await drain(mboxFolder(messages()));
    const entries = parseMbox(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.envelopeFrom).toBe('a@example.org');
    expect(entries[0]?.body).toBe('Subject: one\n\nbody one\n');
    expect(entries[1]?.envelopeFrom).toBe('b@example.org');
    expect(entries[1]?.body).toBe('Subject: two\n\nFrom inside body two\n');
  });

  it('defaults an empty envelope sender to MAILER-DAEMON', async () => {
    const date = new Date(Date.UTC(2026, 0, 1));
    const text = await drain(mboxEntry({ envelopeFrom: '', date, raw: Readable.from([Buffer.from('x\r\n')]) }));
    expect(text.startsWith('From MAILER-DAEMON ')).toBe(true);
  });
});
