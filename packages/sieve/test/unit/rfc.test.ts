// PST-REQ-148 acceptance: "RFC test scripts pass". Every script under test/fixtures/rfc is an
// example from RFC 5228, 5229, 5230, 5232, 5173 or 5490 (or, for postroom-bucket, the Postroom
// extension's README), run against messages chosen to take each branch, with the actions expected.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileScript, execute, type ExecuteOptions, type VacationAction } from '../../src/index.js';
import { FIXTURES, fixture, message, summarize, type MessageSpec } from './helpers.js';

interface Case {
  readonly name: string;
  readonly message?: MessageSpec;
  readonly options?: ExecuteOptions;
  readonly actions: readonly string[];
  readonly bucket?: string | null;
}

const ME: ExecuteOptions = { userAddresses: ['me@example.com'] };

const multipart = (parts: string[]): string => `${parts.map((p) => `--b\r\n${p}\r\n`).join('')}--b--\r\n`;
const MULTIPART = { 'Content-Type': 'multipart/mixed; boundary=b', 'MIME-Version': '1.0' };

const CASES: Record<string, readonly Case[]> = {
  'rfc5228-9-example.sieve': [
    { name: 'IETF list mail goes to "filter"', message: { headers: { Sender: 'owner-ietf-mta-filters@imc.org' } }, actions: ['fileinto filter'] },
    { name: 'company mail is kept', message: { headers: { From: 'Boss <boss@example.com>' } }, actions: ['keep INBOX'] },
    {
      name: 'mail not addressed to me is spam',
      message: { headers: { From: 'x@other.example', To: 'someone@other.example' } },
      actions: ['fileinto spam'],
    },
    {
      name: 'a spam subject is spam',
      message: { headers: { From: 'x@other.example', To: 'list@lists.example.net', Cc: 'me@example.com', Subject: 'MAKE lots of Money FAST' } },
      actions: ['fileinto spam'],
    },
    {
      name: 'everything else is personal',
      message: { headers: { From: 'friend@other.example', To: 'list@lists.example.net', Cc: 'me@example.com' } },
      actions: ['fileinto personal'],
    },
  ],
  'rfc5228-3.1-if.sieve': [
    { name: 'if', message: { headers: { From: 'Wile E. <coyote@desert.example>' } }, actions: ['discard'] },
    { name: 'elsif', message: { headers: { Subject: 'Win $$$ now' } }, actions: ['discard'] },
    { name: 'else', actions: ['fileinto INBOX'] },
  ],
  'rfc5228-3.3-stop.sieve': [
    { name: 'stop leaves the implicit keep', message: { headers: { Subject: 'please stop here' } }, actions: ['keep INBOX (implicit)'] },
    { name: 'otherwise discard', actions: ['discard'] },
  ],
  'rfc5228-4.1-fileinto.sieve': [
    { name: 'from coyote', message: { headers: { From: 'coyote@desert.example' } }, actions: ['fileinto INBOX.harassment'] },
    { name: 'from anyone else', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5228-4.2-redirect.sieve': [
    { name: 'to a foreign address: refused, the message is kept', actions: ['redirect bart@example.com (refused)', 'keep INBOX (implicit)'] },
    { name: "to the account's own address: allowed", options: { userAddresses: ['bart@example.com'] }, actions: ['redirect bart@example.com'] },
  ],
  'rfc5228-4.3-keep.sieve': [
    { name: 'under 1M is kept', actions: ['keep INBOX'] },
    { name: 'over 1M is discarded', message: { body: `${'x'.repeat(1000)}\r\n`.repeat(1100) }, actions: ['discard'] },
  ],
  'rfc5228-5.1-address.sieve': [
    { name: 'address with a display name', message: { headers: { From: 'Tim <tim@example.com>' } }, actions: ['discard'] },
    { name: 'case-insensitive by default', message: { headers: { From: 'TIM@Example.COM' } }, actions: ['discard'] },
    { name: 'someone else', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5228-5.2-allof.sieve': [
    { name: 'both', message: { headers: { From: 'Dick Cheney <dick@example.gov>', Subject: 'going fishing' } }, actions: ['discard'] },
    { name: 'only one', message: { headers: { From: 'Dick Cheney <dick@example.gov>' } }, actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5228-5.3-anyof.sieve': [
    { name: 'one is enough', message: { headers: { Subject: 'fishing trip' } }, actions: ['discard'] },
    { name: 'neither', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5228-5.4-envelope.sieve': [
    { name: 'envelope from matches', message: { envelopeFrom: 'tim@example.com' }, actions: ['discard'] },
    { name: 'the From header does not count', message: { headers: { From: 'tim@example.com' } }, actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5228-5.5-exists.sieve': [
    { name: 'missing Date', message: { omit: ['Date'] }, actions: ['discard'] },
    { name: 'both present', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5228-5.7-header.sieve': [
    { name: 'present and empty', message: { headers: { 'X-Caffeine': '' } }, actions: ['discard', 'keep INBOX'] },
    { name: 'present and not empty', message: { headers: { 'X-Caffeine': 'espresso' } }, actions: ['keep INBOX'] },
    { name: 'absent: the empty key never matches a missing header', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5228-5.9-size.sieve': [
    { name: 'small', actions: ['keep INBOX (implicit)'] },
    { name: 'large', message: { body: `${'y'.repeat(999)}\r\n`.repeat(520) }, actions: ['discard'] },
  ],
  'rfc5229-3.2-match-variables.sieve': [
    { name: 'List-ID', message: { headers: { 'List-ID': 'Road runners <runners@lists.example.org>' } }, actions: ['fileinto INBOX.lists.runners'] },
    { name: 'Subject, shortest first wildcard', message: { headers: { Subject: '[acme-users] [fwd] version 1.0 is out' } }, actions: ['fileinto INBOX.lists.acme-users'] },
    { name: 'address with **', message: { headers: { To: 'coyote@ACME.Example.COM' } }, actions: ['fileinto INBOX.business.ACME.Example'] },
    { name: 'nothing matches: anyof(true, …) stops', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5229-3-expansion.sieve': [
    {
      name: 'the RFC expansion table',
      actions: ['fileinto &%${}!', 'fileinto ${doh!}', 'fileinto x', 'fileinto ACME', 'fileinto ${BADACME', 'fileinto ${President, ACME Inc.}'],
    },
  ],
  'rfc5229-4-set-modifiers.sieve': [
    { name: 'the RFC modifier table', actions: ['fileinto 15', 'fileinto jumbled letters', 'fileinto JuMBlEd lETteRS', 'fileinto Jumbled letters', 'fileinto Rock\\*'] },
  ],
  'rfc5229-5-string.sieve': [{ name: 'always succeeds', actions: ['discard'] }],
  'rfc5229-6-vacation-subject.sieve': [
    {
      name: '${1} carries the subject',
      message: { headers: { Subject: 'Lunch?' } },
      options: ME,
      actions: ['vacation to sender@example.org days 7 subject "Automatic response to: Lunch?"', 'keep INBOX (implicit)'],
    },
  ],
  'rfc5230-4-vacation.sieve': [
    {
      name: 'default subject is "Auto: " + the original',
      message: { headers: { Subject: 'cyrus is broken' } },
      options: ME,
      actions: ['vacation to sender@example.org days 7 subject "Auto: cyrus is broken"', 'keep INBOX (implicit)'],
    },
  ],
  'rfc5230-4-days-addresses.sieve': [
    {
      name: ':days and :addresses',
      message: { headers: { To: 'Tim <tjs@example.edu>' }, envelopeTo: 'tim@mail.example.edu' },
      actions: ['vacation to sender@example.org days 23 subject "Auto: hello"', 'keep INBOX (implicit)'],
    },
    {
      name: ':days is clamped to the site maximum',
      message: { headers: { To: 'tjs@example.edu' } },
      options: { maxVacationDays: 14 },
      actions: ['vacation to sender@example.org days 14 subject "Auto: hello"', 'keep INBOX (implicit)'],
    },
    {
      name: 'not addressed to any of my addresses',
      message: { headers: { To: 'someone@example.edu' }, envelopeTo: 'tim@mail.example.edu' },
      actions: [`vacation to sender@example.org days 23 subject "Auto: hello" (suppressed: none of the account's addresses is in To, Cc or Bcc)`, 'keep INBOX (implicit)'],
    },
  ],
  'rfc5230-4-redirect-or-vacation.sieve': [
    { name: 'boss mail: redirect refused, message kept', message: { headers: { From: 'boss@example.edu' } }, actions: ['redirect pleeb@isp.example.org (refused)', 'keep INBOX (implicit)'] },
    {
      name: 'boss mail: redirect to an owned address',
      message: { headers: { From: 'boss@example.edu' } },
      options: { ownsAddress: (a) => a === 'pleeb@isp.example.org' },
      actions: ['redirect pleeb@isp.example.org'],
    },
    { name: 'everyone else: vacation', options: ME, actions: ['vacation to sender@example.org days 7 subject "Auto: hello"', 'keep INBOX (implicit)'] },
  ],
  'rfc5230-4-language.sieve': [
    { name: 'English', message: { headers: { 'Content-Language': 'en' } }, options: ME, actions: ['vacation to sender@example.org days 7 subject "Auto: hello"', 'keep INBOX (implicit)'] },
  ],
  'rfc5230-4-subject.sieve': [
    { name: 'my division', message: { headers: { From: 'pat@ourdivision.example.com' }, envelopeFrom: 'pat@ourdivision.example.com' }, options: ME, actions: ['vacation to pat@ourdivision.example.com days 7 subject "Gone fishing"', 'keep INBOX (implicit)'] },
    { name: 'everyone else', options: ME, actions: ['vacation to sender@example.org days 7 subject "Je suis parti cette semaine"', 'keep INBOX (implicit)'] },
  ],
  'rfc5230-4.8-mime.sieve': [{ name: ':mime', options: ME, actions: ['vacation to sender@example.org days 7 subject "Auto: hello"', 'keep INBOX (implicit)'] }],
  'rfc5232-4-flag-variables.sieve': [
    {
      name: 'from the boss',
      message: { headers: { From: 'boss@frobnitzm.example.edu' } },
      actions: ['fileinto INBOX.From Boss [\\Flagged]', 'fileinto Archive [\\Answered \\Seen]'],
    },
    { name: 'anyone else', actions: ['fileinto Archive [\\Answered \\Seen]'] },
  ],
  'rfc5232-5-hasflag.sieve': [{ name: 'the RFC hasflag table', actions: ['fileinto t1', 'fileinto t2', 'fileinto t3', 'fileinto t4', 'fileinto t5', 'fileinto t8'] }],
  'rfc5232-7-example.sieve': [
    { name: 'boss', message: { headers: { From: 'boss@frobnitzm.example.edu' } }, actions: ['fileinto From Boss [\\Flagged]'] },
    { name: 'list mail about project X', message: { headers: { Subject: '[acme-users] Project X ships' } }, actions: ['fileinto Lists [\\Seen \\Flagged]'] },
    { name: 'list mail', message: { headers: { Subject: '[acme-users] hi' } }, actions: ['fileinto Lists [\\Seen]'] },
    { name: 'the implicit keep takes the internal flags', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5173-body-content.sieve': [
    {
      name: 'text and audio parts',
      message: {
        headers: MULTIPART,
        body: multipart([
          'Content-Type: text/plain\r\n\r\nThe coordinates are attached.',
          'Content-Type: audio/mp3\r\nContent-Transfer-Encoding: base64\r\n\r\nSUQzAwAAAAAA',
        ]),
      },
      actions: ['fileinto secrets', 'fileinto jukebox'],
    },
    {
      name: 'quoted-printable is decoded before matching',
      message: { headers: { 'Content-Transfer-Encoding': 'quoted-printable' }, body: 'the mis=\r\nsile is ready\r\n' },
      actions: ['fileinto secrets'],
    },
    { name: 'neither', actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5173-body-text.sieve': [
    { name: 'plain text', message: { body: 'The Project Schedule slipped.\r\n' }, actions: ['fileinto project/schedule'] },
    {
      name: 'html, tags removed',
      message: { headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<p>The project <b>schedule</b></p>\r\n' },
      actions: ['fileinto project/schedule'],
    },
    {
      name: 'attachments are not text',
      message: { headers: MULTIPART, body: multipart(['Content-Type: text/plain\r\n\r\nsee attached', 'Content-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\nproject schedule']) },
      actions: ['keep INBOX (implicit)'],
    },
  ],
  'rfc5173-body-raw.sieve': [
    { name: 'plain', message: { body: 'MAKE MONEY FAST\r\n' }, actions: ['discard'] },
    { name: 'base64 hides it from :raw', message: { headers: { 'Content-Transfer-Encoding': 'base64' }, body: `${Buffer.from('MAKE MONEY FAST').toString('base64')}\r\n` }, actions: ['keep INBOX (implicit)'] },
  ],
  'rfc5490-create.sieve': [
    { name: ':create', actions: ['fileinto INBOX.folder :create'] },
    { name: 'mailboxexists', options: { mailboxExists: (m) => m === 'Archive' }, actions: ['fileinto INBOX.folder :create', 'fileinto Archive'] },
  ],
  'postroom-bucket.sieve': [
    { name: 'newsletter', message: { headers: { 'List-Unsubscribe': '<mailto:u@news.example>' } }, actions: ['keep INBOX (implicit)'], bucket: 'newsletters' },
    { name: 'receipt from a variable', message: { headers: { From: 'orders@store.shop.example' } }, actions: ['keep INBOX (implicit)'], bucket: 'receipts' },
    { name: 'neither', actions: ['keep INBOX (implicit)'], bucket: null },
  ],
};

describe('RFC example scripts (PST-REQ-148)', () => {
  it('has expectations for every fixture script', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.sieve'));
    expect(files.filter((f) => !(f in CASES) && f !== 'rfc5228-2.4.2-multiline.sieve')).toEqual([]);
  });

  for (const [file, cases] of Object.entries(CASES)) {
    describe(file, () => {
      const script = compileScript(fixture(file));
      for (const c of cases) {
        it(c.name, () => {
          const result = execute(script, message(c.message), c.options);
          expect(result.error).toBeNull();
          expect(summarize(result)).toEqual(c.actions);
          if (c.bucket !== undefined) expect(result.bucket).toBe(c.bucket);
        });
      }
    });
  }

  it('multi-line strings: dot-stuffing removed, lines end in CRLF (RFC 5228 §2.4.2)', () => {
    const result = execute(compileScript(fixture('rfc5228-2.4.2-multiline.sieve')), message(), ME);
    expect((result.actions[0] as VacationAction).reason).toBe('Line one.\r\n.dot-stuffed line\r\n');
  });

  it('vacation reasons and :mime come through intact', () => {
    const lang = execute(compileScript(fixture('rfc5230-4-language.sieve')), message(), ME);
    expect((lang.actions[0] as VacationAction).reason).toBe('Estoy ausente esta semana.');
    const mime = execute(compileScript(fixture('rfc5230-4.8-mime.sieve')), message(), ME).actions[0] as VacationAction;
    expect(mime.mime).toBe(true);
    expect(mime.reason.startsWith('Content-Type: multipart/alternative; boundary=foo\r\n\r\n--foo\r\n')).toBe(true);
    const days = execute(compileScript(fixture('rfc5230-4-days-addresses.sieve')), message({ headers: { To: 'tjs@example.edu' } })).actions[0] as VacationAction;
    expect(days.reason).toBe("I'm away until October 19.\nIf it's an emergency, call 911, I guess.");
  });
});
