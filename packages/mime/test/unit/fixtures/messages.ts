// Small .eml fixtures, written as strings so their exact bytes (CRLF, ESC, 8-bit) are visible.
// All synthetic. `crlf` turns the readable LF-only template into wire format.

export const crlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

/** RFC 2047 §8 — the examples, verbatim. */
export const rfc2047Examples = crlf(`From: =?US-ASCII?Q?Keith_Moore?= <moore@cs.utk.edu>
To: =?ISO-8859-1?Q?Keld_J=F8rn_Simonsen?= <keld@dkuug.dk>
CC: =?ISO-8859-1?Q?Andr=E9?= Pirard <PIRARD@vm1.ulg.ac.be>
Subject: =?ISO-8859-1?B?SWYgeW91IGNhbiByZWFkIHRoaXMgeW8=?=
    =?ISO-8859-2?B?dSB1bmRlcnN0YW5kIHRoZSBleGFtcGxlLg==?=

body
`);

/** RFC 2047 §8 — the encoded-word whitespace table: [encoded, displayed]. */
export const rfc2047Table: readonly (readonly [string, string])[] = [
  ['(=?ISO-8859-1?Q?a?=)', '(a)'],
  ['(=?ISO-8859-1?Q?a?= b)', '(a b)'],
  ['(=?ISO-8859-1?Q?a?= =?ISO-8859-1?Q?b?=)', '(ab)'],
  ['(=?ISO-8859-1?Q?a?=  =?ISO-8859-1?Q?b?=)', '(ab)'],
  ['(=?ISO-8859-1?Q?a?=\r\n    =?ISO-8859-1?Q?b?=)', '(ab)'],
  ['(=?ISO-8859-1?Q?a_b?=)', '(a b)'],
  ['(=?ISO-8859-1?Q?a?= =?ISO-8859-2?Q?_b?=)', '(a b)'],
];

/** RFC 2231 §3, §4, §4.1 — continuations, charset/language, and both combined. */
export const rfc2231Continuation = crlf(`Content-Type: message/external-body; access-type=URL;
         URL*0="ftp://";
         URL*1="cs.utk.edu/pub/moore/bulk-mailer/bulk-mailer.tar"
`);
export const rfc2231Charset = crlf(`Content-Type: application/x-stuff;
    title*=us-ascii'en-us'This%20is%20%2A%2A%2Afun%2A%2A%2A
`);
export const rfc2231Combined = crlf(`Content-Type: application/x-stuff;
    title*0*=us-ascii'en'This%20is%20even%20more%20;
    title*1*=%2A%2A%2Afun%2A%2A%2A%20;
    title*2="isn't it!"
`);

/** What Gmail sends: mixed → related → alternative, with an inline cid: image and an attachment. */
export const gmailStyle = crlf(`MIME-Version: 1.0
Date: Thu, 24 Sep 2026 09:15:02 -0400
Message-ID: <CAF+abc123@mail.gmail.com>
In-Reply-To: <parent@example.org>
References: <root@example.org>
 <parent@example.org>
Subject: Photos from =?UTF-8?Q?the_caf=C3=A9?=
From: =?UTF-8?B?QW5kcsOp?= <andre@example.com>
To: "Doe, Jane" <jane@d3cloud.io>, bob@example.net (Bob B.)
Content-Type: multipart/mixed; boundary="000000000000mixed"

--000000000000mixed
Content-Type: multipart/related; boundary="000000000000related"

--000000000000related
Content-Type: multipart/alternative; boundary="000000000000alt"

--000000000000alt
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

Here they are =E2=80=94 see the one inline.
[image: cafe.png]

--000000000000alt
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

<div dir=3D"ltr">Here they are =E2=80=94 see the one inline.<img src=3D"cid=
:ii_cafe01" alt=3D"cafe.png"></div>

--000000000000alt--
--000000000000related
Content-Type: image/png; name="cafe.png"
Content-Disposition: inline; filename="cafe.png"
Content-Transfer-Encoding: base64
Content-ID: <ii_cafe01>
X-Attachment-Id: ii_cafe01

iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9
awAAAABJRU5ErkJggg==
--000000000000related--
--000000000000mixed
Content-Type: application/pdf; name="=?UTF-8?Q?men=C3=BC=2Epdf?="
Content-Disposition: attachment; filename="=?UTF-8?Q?men=C3=BC=2Epdf?="
Content-Transfer-Encoding: base64

JVBERi0xLjQKJcOkw7zDtsOfCg==
--000000000000mixed--
`);

/** A forwarded message: the original travels as message/rfc822. */
export const forward = crlf(`From: alice@example.com
To: bob@example.com
Subject: Fwd: plans
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: text/plain

See below.
--outer
Content-Type: message/rfc822
Content-Disposition: inline

From: carol@example.com
To: alice@example.com
Subject: plans
Message-ID: <orig@example.com>
Content-Type: multipart/alternative; boundary="inner"

--inner
Content-Type: text/plain

Original text.
--inner
Content-Type: text/html

<p>Original text.</p>
--inner--

--outer--
`);

/** The closing delimiter never arrives. */
export const missingClose = crlf(`Subject: truncated
Content-Type: multipart/mixed; boundary="b1"

preamble
--b1
Content-Type: text/plain

first
--b1
Content-Type: text/plain

second, and then the message just stops
`);

/** A plain two-part message used to split a delimiter at every byte offset. */
export const twoParts = crlf(`Subject: split
Content-Type: multipart/alternative; boundary="split-me-here"

--split-me-here
Content-Type: text/plain

alpha
--split-me-here
Content-Type: text/plain
Content-Transfer-Encoding: base64

YmV0YQ==
--split-me-here--
`);

/** RFC 2231 continuation plus an encoded-word filename, as mail clients send them. */
export const filenames = crlf(`Content-Type: multipart/mixed; boundary=zz

--zz
Content-Type: application/octet-stream
Content-Disposition: attachment;
 filename*0*=utf-8''%E6%97%A5%E6%9C%AC%E8%AA%9E;
 filename*1*=%2Etxt
Content-Transfer-Encoding: base64

aGk=
--zz
Content-Type: application/octet-stream; name="=?ISO-8859-1?Q?r=E9sum=E9=2Epdf?="
Content-Transfer-Encoding: base64

aGk=
--zz--
`);

/** A windows-1252 body (smart quotes, euro sign) in quoted-printable. */
export const windows1252 = crlf(`Subject: =?windows-1252?Q?=93quoted=94?=
Content-Type: text/plain; charset=windows-1252
Content-Transfer-Encoding: quoted-printable

=93Hello=94 =96 it costs =80 5.
`);

/** An iso-2022-jp body: 7-bit with escape sequences (こんにちは). */
export const iso2022jp = crlf(`Subject: =?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=
Content-Type: text/plain; charset=ISO-2022-JP
Content-Transfer-Encoding: 7bit

\x1b$B$3$s$K$A$O\x1b(B
`);
