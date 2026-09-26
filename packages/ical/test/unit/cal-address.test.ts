// CAL-ADDRESS → e-mail (PST-T-8.4, PST-REQ-134): an ORGANIZER/ATTENDEE value decodes to exactly one
// RFC 5321 mailbox or to nothing. The verifier's PoC — a percent-encoded CRLF smuggling an SMTP
// command into what becomes the reply's envelope recipient and To: header — must yield null.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calAddressEmail, getProperty, parseICalendar } from '../../src/index.js';
import { isMailbox } from '../../src/values.js';

describe('calAddressEmail (PST-T-8.4)', () => {
  it('decodes a plain and a percent-encoded mailto', () => {
    expect(calAddressEmail('mailto:priya@example.com')).toBe('priya@example.com');
    expect(calAddressEmail('MAILTO:Priya.Patel+cal@Example.COM')).toBe('Priya.Patel+cal@Example.COM');
    expect(calAddressEmail('mailto:priya%40example.com')).toBe('priya@example.com');
    expect(calAddressEmail('mailto:jörg@bücher.example')).toBe('jörg@bücher.example');
    expect(calAddressEmail('mailto:a@xn--bcher-kva.example')).toBe('a@xn--bcher-kva.example');
  });

  it('refuses the verifier’s PoC: a percent-encoded CRLF + RCPT TO', () => {
    expect(calAddressEmail('mailto:evil%40attacker.example%0d%0aRCPT%20TO:%3cvictim%40external.example%3e')).toBeNull();
  });

  it('refuses %0a alone, %0d alone, and a NUL', () => {
    expect(calAddressEmail('mailto:evil@attacker.example%0aBcc:%20victim@external.example')).toBeNull();
    expect(calAddressEmail('mailto:evil@attacker.example%0dBcc:%20victim@external.example')).toBeNull();
    expect(calAddressEmail('mailto:evil@attacker.example%0d')).toBeNull();
    expect(calAddressEmail('mailto:evil%00@attacker.example')).toBeNull();
    expect(calAddressEmail('mailto:evil@attacker.example%7f')).toBeNull();
  });

  it('refuses a raw CR or LF in the value, and a folded line cannot smuggle one past the lexer', () => {
    // Directly: a raw CR/LF/CRLF inside the value, as if a lexer had let it through.
    expect(calAddressEmail('mailto:evil@attacker.example\rRCPT TO:<victim@external.example>')).toBeNull();
    expect(calAddressEmail('mailto:evil@attacker.example\nBcc: victim@external.example')).toBeNull();
    expect(calAddressEmail('mailto:evil@attacker.example\r\n RCPT TO:<victim@external.example>')).toBeNull();
    // Through the parser: a bare CR in a folded continuation is a line break, never part of the value.
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:x', 'ORGANIZER;CN=Evil:mailto:evil@attacker.exa', ' mple\rRCPT TO:<victim@external.example>', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const organizerOf = (text: string): string | null => {
      try {
        const ev = parseICalendar(text).components[0];
        return (ev && getProperty(ev, 'ORGANIZER')?.value) ?? null;
      } catch {
        return null;
      }
    };
    const value = organizerOf(ics);
    expect((value === null ? null : calAddressEmail(value)) ?? '').not.toMatch(/[\r\n]/);
    // And a folded ORGANIZER that unfolds to a clean address still decodes.
    const clean = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:x', 'ORGANIZER;CN=Priya:mailto:priya@exa', ' mple.com', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const ev = parseICalendar(clean).components[0];
    expect(calAddressEmail((ev && getProperty(ev, 'ORGANIZER')?.value) ?? '')).toBe('priya@example.com');
  });

  it('refuses comma lists, semicolons, angle brackets, whitespace and a second @', () => {
    expect(calAddressEmail('mailto:a@example.com,b@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a@example.com%2Cb@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a@example.com;b@example.com')).toBeNull();
    expect(calAddressEmail('mailto:%3Ca@example.com%3E')).toBeNull();
    expect(calAddressEmail('mailto:<a@example.com>')).toBeNull();
    expect(calAddressEmail('mailto:a b@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a%20b@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a%09@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a@b@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a%40b%40example.com')).toBeNull();
  });

  it('refuses things that are not a single mailbox', () => {
    expect(calAddressEmail('mailto:')).toBeNull();
    expect(calAddressEmail('mailto:@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a@')).toBeNull();
    expect(calAddressEmail('mailto:.a@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a..b@example.com')).toBeNull();
    expect(calAddressEmail('mailto:a@-example.com')).toBeNull();
    expect(calAddressEmail('mailto:a@exa_mple.com')).toBeNull();
    expect(calAddressEmail('mailto:a@example..com')).toBeNull();
    expect(calAddressEmail('mailto:a@[192.0.2.1]')).toBeNull();
    expect(calAddressEmail('mailto:"a b"@example.com')).toBeNull();
    expect(calAddressEmail(`mailto:${'a'.repeat(65)}@example.com`)).toBeNull();
    expect(calAddressEmail('mailto:a@example.com%')).toBeNull();
    expect(calAddressEmail('https://example.com/a@b')).toBeNull();
    expect(calAddressEmail('a@example.com')).toBeNull();
  });

  it('property: every decoded result is one mailbox with no control character, whitespace or header delimiter', () => {
    const chars = fc.constantFrom('a', 'Z', '0', '.', '@', '-', '_', '+', '%0d', '%0a', '%0D%0A', '%40', '%2C', '%3C', '%3E', ' ', '\t', ',', ';', '<', '>', '\r', '\n', '\u0000', 'ü', ':');
    fc.assert(
      fc.property(fc.array(chars, { maxLength: 40 }), (parts) => {
        const out = calAddressEmail(`mailto:${parts.join('')}`);
        if (out === null) return;
        // eslint-disable-next-line no-control-regex -- the property under test
        expect(out).not.toMatch(/[\u0000-\u001f\u007f\s<>,;]/u);
        expect(out.split('@')).toHaveLength(2);
        expect(isMailbox(out)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('property: never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = calAddressEmail(`mailto:${s}`);
        expect(out === null || isMailbox(out)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
