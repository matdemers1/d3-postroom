// SMTP smuggling fixtures (SEC Consult, December 2023; https://smtpsmuggling.com).
//
// An attacker ends DATA with something a lenient server takes as <CRLF>.<CRLF> but a strict one
// does not (or the reverse), then pipelines a second MAIL/RCPT/DATA that the lenient hop executes
// as a new, spoofed message. We enumerate every combination of {nothing, CR, LF, CRLF} before and
// after the dot, plus the published NUL and doubled-line-ending variants. Only "\r\n.\r\n" may end
// DATA. Every variant containing a bare CR or LF (or a NUL) must get the message rejected with a
// 5xx; the rest (e.g. "\r\n." followed by text) are ordinary dot-stuffed data and stay data.

export interface SmugglingCase {
  readonly name: string;
  /** The would-be end-of-data sequence the attacker uses. */
  readonly sequence: string;
  /** True when the message must be rejected (bare CR/LF or NUL in the data). */
  readonly reject: boolean;
}

const SEPARATORS: readonly (readonly [string, string])[] = [
  ['nothing', ''],
  ['CR', '\r'],
  ['LF', '\n'],
  ['CRLF', '\r\n'],
];

function hasBareLineEndingOrNul(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\r(?!\n)|(?<!\r)\n|\x00/.test(s);
}

function enumerate(): SmugglingCase[] {
  const out: SmugglingCase[] = [];
  for (const [bn, before] of SEPARATORS) {
    for (const [an, after] of SEPARATORS) {
      if (before === '\r\n' && after === '\r\n') continue; // the one real terminator
      const sequence = `${before}.${after}`;
      out.push({ name: `${bn} . ${an}`, sequence, reject: hasBareLineEndingOrNul(sequence) });
    }
  }
  const extra: readonly (readonly [string, string])[] = [
    ['CRLF NUL . CRLF', '\r\n\x00.\r\n'],
    ['LF LF . LF LF', '\n\n.\n\n'],
    ['CR CR . CR CR', '\r\r.\r\r'],
    ['CRLF . CR CRLF', '\r\n.\r\r\n'],
    ['CRLF CR . CRLF', '\r\n\r.\r\n'],
    ['CRLF . LF CRLF', '\r\n.\n\r\n'],
    ['CRLF LF . CRLF', '\r\n\n.\r\n'],
    ['CRLF . NUL CRLF', '\r\n.\x00\r\n'],
    ['CRLF . CR NUL CRLF', '\r\n.\r\x00\r\n'],
    ['CRLF .. LF', '\r\n..\n'],
    ['CRLF . SP CRLF', '\r\n. \r\n'],
  ];
  for (const [name, sequence] of extra) {
    out.push({ name, sequence, reject: hasBareLineEndingOrNul(sequence) });
  }
  return out;
}

export const SMUGGLING_CASES: readonly SmugglingCase[] = enumerate();

/** The commands an attacker pipelines after the fake terminator. */
export const SMUGGLED_COMMANDS = 'MAIL FROM:<ceo@victim.example>\r\nRCPT TO:<target@victim.example>\r\nDATA\r\nFrom: ceo@victim.example\r\n\r\nwire the money\r\n';

/** A full DATA body (as sent, before the real terminator) carrying the smuggling attempt. */
export function smugglingBody(sequence: string): string {
  return `From: attacker@evil.example\r\nSubject: hi\r\n\r\nhello${sequence}${SMUGGLED_COMMANDS}`;
}
