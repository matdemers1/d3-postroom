// Synthetic RFC 5322 messages for the IMAP tests: a nested multipart with an attachment, a UTF-8
// subject in an encoded word, a group address, and a forwarded message/rfc822.
const crlf = (lines: readonly string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8');

/** 28 octets of a (tiny) PDF: one 40-character base64 line in the message. */
export const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake report\n%%EOF\n', 'latin1');

/** multipart/mixed → [multipart/alternative → [text/plain (QP), text/html], application/pdf]. */
export const MULTIPART = crlf([
  'From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <juergen@example.com>',
  'To: Alice <alice@d3cloud.io>, bob@d3cloud.io',
  'Cc: team: carol@example.org, dave@example.org;',
  'Subject: =?UTF-8?B?w5xiZXIgZGVuIFdvbGtlbg==?= report',
  'Date: Tue, 22 Sep 2026 10:00:00 +0200',
  'Message-ID: <msg1@example.com>',
  'In-Reply-To: <parent@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  'This is a preamble.',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hallo Welt =E2=80=94 plain',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hallo <b>Welt</b></p>',
  '--inner--',
  '--outer',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  PDF_BYTES.toString('base64'),
  '--outer--',
  'epilogue',
  '',
]);

/** A plain text message with a UTF-8 (RFC 6532) subject — and no Content-Type at all. */
export const PLAIN = crlf([
  'From: Bob <bob@example.net>',
  'To: alice@d3cloud.io',
  'Subject: Lunch?',
  'Date: Wed, 23 Sep 2026 12:30:00 +0000',
  'Message-ID: <lunch@example.net>',
  '',
  'Are you free for lunch tomorrow?',
  'The usual place.',
  '',
]);

/** A forward: text/plain + message/rfc822. */
export const FORWARD = crlf([
  'From: carol@example.org',
  'To: alice@d3cloud.io',
  'Subject: Fwd: minutes',
  'Date: Thu, 24 Sep 2026 08:00:00 -0500',
  'Message-ID: <fwd@example.org>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary=b1',
  '',
  '--b1',
  'Content-Type: text/plain',
  '',
  'See below.',
  '--b1',
  'Content-Type: message/rfc822',
  '',
  'From: dave@example.org',
  'Subject: minutes',
  'Date: Mon, 21 Sep 2026 09:00:00 +0000',
  '',
  'Item one.',
  '--b1--',
  '',
]);

/**
 * Hand-written BODYSTRUCTURE and ENVELOPE of MULTIPART. Sizes and line counts, by hand:
 *   text/plain body "Hallo Welt =E2=80=94 plain" = 26 octets, 1 line;
 *   text/html body "<p>Hallo <b>Welt</b></p>" = 24 octets, 1 line;
 *   the pdf body is the 40-character base64 line;
 * the CRLF before each boundary belongs to the boundary (RFC 2046 §5.1.1).
 */
export const MULTIPART_BODYSTRUCTURE =
  'BODYSTRUCTURE ((' +
  '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 26 1 NIL NIL NIL NIL)' +
  '("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 24 1 NIL NIL NIL NIL)' +
  ' "ALTERNATIVE" ("BOUNDARY" "inner") NIL NIL NIL)' +
  '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 40 NIL ("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL)' +
  ' "MIXED" ("BOUNDARY" "outer") NIL NIL NIL)';

export const MULTIPART_ENVELOPE =
  'ENVELOPE ("Tue, 22 Sep 2026 10:00:00 +0200" "=?UTF-8?B?w5xiZXIgZGVuIFdvbGtlbg==?= report" ' +
  '(("=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?=" NIL "juergen" "example.com")) ' +
  '(("=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?=" NIL "juergen" "example.com")) ' +
  '(("=?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?=" NIL "juergen" "example.com")) ' +
  '(("Alice" NIL "alice" "d3cloud.io")(NIL NIL "bob" "d3cloud.io")) ' +
  '((NIL NIL "team" NIL)(NIL NIL "carol" "example.org")(NIL NIL "dave" "example.org")(NIL NIL NIL NIL)) ' +
  'NIL "<parent@example.com>" "<msg1@example.com>")';

export const PLAIN_BODYSTRUCTURE = 'BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 52 2 NIL NIL NIL NIL)';
