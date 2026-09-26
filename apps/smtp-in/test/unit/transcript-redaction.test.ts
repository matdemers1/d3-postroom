// PST-T-6.3, PST-REQ-117: AUTH credentials never reach the stored transcript or the live view,
// however the client's bytes are chunked and however they interleave with the server's replies.
// Redaction starts on the client's AUTH line itself, not on the server's 334 (the refutation this
// file answers: `AUTH PLAIN\r\n<base64>\r\n` pipelined in one read used to store the secret).
//
// This file is identical in apps/smtp-in and apps/submission (as is src/transcript.ts): the two
// daemons keep their own copies because neither may depend on the other, so both run the same table.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { AuthRedactor, parseTranscriptText, TranscriptRecorder } from '../../src/transcript.js';

interface Harness {
  readonly r: TranscriptRecorder;
  /** Every line published to the live view (pg_notify payload's `line`), in order. */
  readonly published: string[];
}

/** A recorder whose live publishes land in `published` instead of Postgres. */
function harness(): Harness {
  const published: string[] = [];
  const db = {
    $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const payload = JSON.parse(String(values[1])) as { line: string };
      published.push(payload.line);
      return Promise.resolve(0);
    },
  } as unknown as Db;
  const r = new TranscriptRecorder({ daemon: 'smtp-in', sessionId: 'sess-r', clientIp: '203.0.113.9', db });
  return { r, published };
}

type Step = readonly ['C' | 'S', string];

function run(steps: readonly Step[]): Harness {
  const h = harness();
  for (const [dir, raw] of steps) {
    const buf = Buffer.from(raw, 'latin1');
    if (dir === 'C') h.r.recordIncomingRaw(buf);
    else h.r.recordOutgoingRaw(buf);
  }
  return h;
}

function clientLines(h: Harness): string[] {
  return parseTranscriptText(h.r.snapshotText())
    .filter((e) => e.dir === 'C')
    .map((e) => e.line);
}

function publishedClientLines(h: Harness): string[] {
  // Live lines are published in the same order and with the same redaction as stored ones.
  const entries = parseTranscriptText(h.r.snapshotText());
  return h.published.filter((_, i) => entries[i]?.dir === 'C');
}

const GREET: Step = ['S', '220 mx.d3cloud.io ESMTP Postroom\r\n'];
const EHLO: readonly Step[] = [
  ['C', 'EHLO client.example\r\n'],
  ['S', '250-mx.d3cloud.io\r\n250 AUTH PLAIN LOGIN XOAUTH2\r\n'],
];
const PLAIN = 'AGFsaWNlAHN1cGVyc2VjcmV0'; // \0alice\0supersecret
const USER = 'YWxpY2U=';
const PASS = 'c3VwZXJzZWNyZXQ=';
const XOAUTH = 'dXNlcj1hbGljZQFhdXRoPUJlYXJlciB5YTI5LnRva2VuAQE=';

interface Case {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly secrets: readonly string[];
  /** Every client line as stored (and published live), in order. */
  readonly expected: readonly string[];
}

/** The redaction table: run as-is in both daemons' test suites. */
const TABLE: readonly Case[] = [
  {
    name: "the verifier's repro: AUTH PLAIN and its continuation pipelined in one read, before the 334",
    steps: [GREET, ...EHLO, ['C', `AUTH PLAIN\r\n${PLAIN}\r\n`], ['S', '334 \r\n'], ['S', '235 2.7.0 Authentication successful\r\n'], ['C', 'QUIT\r\n'], ['S', '221 bye\r\n']],
    secrets: [PLAIN],
    expected: ['EHLO client.example', 'AUTH PLAIN', '[redacted]', 'QUIT'],
  },
  {
    name: 'AUTH LOGIN with username and password pipelined with the AUTH line',
    steps: [GREET, ...EHLO, ['C', `AUTH LOGIN\r\n${USER}\r\n${PASS}\r\n`], ['S', '334 VXNlcm5hbWU6\r\n'], ['S', '334 UGFzc3dvcmQ6\r\n'], ['S', '235 2.7.0 ok\r\n'], ['C', 'MAIL FROM:<alice@d3cloud.io>\r\n']],
    secrets: [USER, PASS],
    expected: ['EHLO client.example', 'AUTH LOGIN', '[redacted]', '[redacted]', 'MAIL FROM:<alice@d3cloud.io>'],
  },
  {
    name: 'AUTH LOGIN one line at a time',
    steps: [GREET, ['C', 'AUTH LOGIN\r\n'], ['S', '334 VXNlcm5hbWU6\r\n'], ['C', `${USER}\r\n`], ['S', '334 UGFzc3dvcmQ6\r\n'], ['C', `${PASS}\r\n`], ['S', '235 2.7.0 ok\r\n'], ['C', 'NOOP\r\n']],
    secrets: [USER, PASS],
    expected: ['AUTH LOGIN', '[redacted]', '[redacted]', 'NOOP'],
  },
  {
    name: "lowercase 'auth plain' with a continuation",
    steps: [GREET, ['C', 'auth plain\r\n'], ['S', '334 \r\n'], ['C', `${PLAIN}\r\n`], ['S', '235 2.7.0 ok\r\n'], ['C', 'noop\r\n']],
    secrets: [PLAIN],
    expected: ['AUTH plain', '[redacted]', 'noop'],
  },
  {
    name: "lowercase 'auth plain' with an initial response",
    steps: [GREET, ['C', `auth plain ${PLAIN}\r\n`], ['S', '235 2.7.0 ok\r\n']],
    secrets: [PLAIN],
    expected: ['AUTH plain [redacted]'],
  },
  {
    name: 'AUTH XOAUTH2 with an initial response, then the error challenge and the empty reply',
    steps: [GREET, ['C', `AUTH XOAUTH2 ${XOAUTH}\r\n`], ['S', '334 eyJzdGF0dXMiOiI0MDEifQ==\r\n'], ['C', '\r\n'], ['S', '535 5.7.8 no\r\n'], ['C', 'QUIT\r\n']],
    secrets: [XOAUTH],
    expected: ['AUTH XOAUTH2 [redacted]', '[redacted]', 'QUIT'],
  },
  {
    name: "AUTH PLAIN = (an empty initial response), then the next command after the reply",
    steps: [GREET, ['C', 'AUTH PLAIN =\r\n'], ['S', '535 5.7.8 no\r\n'], ['C', 'RSET\r\n']],
    secrets: [],
    expected: ['AUTH PLAIN [redacted]', 'RSET'],
  },
  {
    name: "a '*' cancel is shown as '*'",
    steps: [GREET, ['C', 'AUTH LOGIN\r\n'], ['S', '334 VXNlcm5hbWU6\r\n'], ['C', '*\r\n'], ['S', '501 5.7.0 cancelled\r\n'], ['C', 'NOOP\r\n']],
    secrets: [],
    expected: ['AUTH LOGIN', '*', 'NOOP'],
  },
  {
    name: 'AUTH + continuation + MAIL FROM in one chunk: MAIL FROM arrives before any reply, so it is redacted (fail closed)',
    steps: [GREET, ['C', `AUTH PLAIN\r\n${PLAIN}\r\nMAIL FROM:<alice@d3cloud.io>\r\n`], ['S', '334 \r\n'], ['S', '235 2.7.0 ok\r\n'], ['S', '250 2.1.0 ok\r\n'], ['C', 'RCPT TO:<bob@example.org>\r\n']],
    secrets: [PLAIN],
    expected: ['AUTH PLAIN', '[redacted]', '[redacted]', 'RCPT TO:<bob@example.org>'],
  },
  {
    name: 'AUTH + continuation in one chunk, MAIL FROM after the 235: MAIL FROM is shown',
    steps: [GREET, ['C', `AUTH PLAIN\r\n${PLAIN}\r\n`], ['S', '334 \r\n'], ['S', '235 2.7.0 ok\r\n'], ['C', 'MAIL FROM:<alice@d3cloud.io>\r\n'], ['S', '250 2.1.0 ok\r\n']],
    secrets: [PLAIN],
    expected: ['AUTH PLAIN', '[redacted]', 'MAIL FROM:<alice@d3cloud.io>'],
  },
  {
    name: 'AUTH with an initial response and MAIL FROM pipelined before any reply',
    steps: [GREET, ['C', `AUTH PLAIN ${PLAIN}\r\nMAIL FROM:<alice@d3cloud.io>\r\n`], ['S', '235 2.7.0 ok\r\n'], ['S', '250 2.1.0 ok\r\n'], ['C', 'DATA\r\n']],
    secrets: [PLAIN],
    expected: ['AUTH PLAIN [redacted]', '[redacted]', 'DATA'],
  },
  {
    name: 'chunk boundaries split the AUTH line, the secret, and the CRLF',
    steps: [GREET, ['C', 'AUTH PL'], ['C', 'AIN\r\nAGFsaW'], ['S', '334 \r\n'], ['C', 'NlAHN1cGVyc2VjcmV0\r'], ['C', '\n'], ['S', '235 2.7.0 ok\r\n'], ['C', 'NO'], ['C', 'OP\r\n']],
    secrets: [PLAIN],
    expected: ['AUTH PLAIN', '[redacted]', 'NOOP'],
  },
  {
    name: "a late reply to an earlier pipelined command never ends the exchange (EHLO's 250 after AUTH was read)",
    steps: [GREET, ['C', 'EHLO client.example\r\nAUTH PLAIN\r\n'], ['S', '250-mx.d3cloud.io\r\n250 AUTH PLAIN\r\n'], ['S', '334 \r\n'], ['C', `${PLAIN}\r\n`], ['S', '235 2.7.0 ok\r\n']],
    secrets: [PLAIN],
    expected: ['EHLO client.example', 'AUTH PLAIN', '[redacted]'],
  },
  {
    name: 'a failed AUTH, then a second AUTH that was pipelined behind it, keeps redacting',
    steps: [GREET, ['C', `AUTH PLAIN\r\n*\r\nAUTH LOGIN\r\n`], ['S', '334 \r\n'], ['S', '501 5.7.0 cancelled\r\n'], ['S', '334 VXNlcm5hbWU6\r\n'], ['C', `${USER}\r\n`], ['S', '334 UGFzc3dvcmQ6\r\n'], ['C', `${PASS}\r\n`], ['S', '235 2.7.0 ok\r\n'], ['C', 'QUIT\r\n']],
    secrets: [USER, PASS],
    expected: ['AUTH PLAIN', '*', '[redacted]', '[redacted]', '[redacted]', 'QUIT'],
  },
  {
    name: 'an unknown mechanism is refused and the exchange ends on that reply',
    steps: [GREET, ['C', 'AUTH FOO-BAR c2VjcmV0MTIz\r\n'], ['S', '504 5.5.4 unrecognized\r\n'], ['C', 'NOOP\r\n']],
    secrets: ['c2VjcmV0MTIz'],
    expected: ['AUTH FOO-BAR [redacted]', 'NOOP'],
  },
  {
    name: 'a mechanism token that does not look like one is redacted too',
    steps: [GREET, ['C', `AUTH ${PASS}\r\n`], ['S', '504 5.5.4 unrecognized\r\n']],
    secrets: [PASS],
    expected: ['AUTH [redacted]'],
  },
  {
    name: 'AUTH refused outright (538 before TLS): the next command is shown',
    steps: [GREET, ['C', `AUTH PLAIN ${PLAIN}\r\n`], ['S', '538 5.7.11 encryption required\r\n'], ['C', 'STARTTLS\r\n']],
    secrets: [PLAIN],
    expected: ['AUTH PLAIN [redacted]', 'STARTTLS'],
  },
];

describe('AUTH redaction table (PST-REQ-117)', () => {
  it.each(TABLE)('$name', ({ steps, secrets, expected }) => {
    const h = run(steps);
    const text = h.r.snapshotText();
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      for (const line of h.published) expect(line).not.toContain(secret);
    }
    expect(clientLines(h)).toEqual(expected);
    expect(publishedClientLines(h)).toEqual(expected);
  });

  it('counts DATA’s body as one answered line, so a later AUTH still lines up with its replies', () => {
    const h = harness();
    const c = (s: string): void => {
      h.r.recordIncomingRaw(Buffer.from(s, 'latin1'));
    };
    const s = (x: string): void => {
      h.r.recordOutgoingRaw(Buffer.from(x, 'latin1'));
    };
    s('220 hi\r\n');
    c('DATA\r\n');
    s('354 go\r\n');
    h.r.beginBody();
    c('Subject: x\r\n\r\nbody\r\n.\r\n');
    h.r.endBody(24);
    // The post-body reply is observed only after the client already pipelined AUTH.
    c('AUTH PLAIN\r\n');
    s('250 2.0.0 queued\r\n');
    s('334 \r\n');
    c(`${PLAIN}\r\n`);
    s('235 2.7.0 ok\r\n');
    c('QUIT\r\n');
    expect(h.r.snapshotText()).not.toContain(PLAIN);
    expect(h.published.join('\n')).not.toContain(PLAIN);
    expect(clientLines(h)).toEqual(['DATA', '[message body: 24 bytes]', 'AUTH PLAIN', '[redacted]', 'QUIT']);
  });

  it('AuthRedactor alone: the state is entered on the AUTH line, before any server output', () => {
    const r = new AuthRedactor();
    expect(r.redactIncoming('AUTH PLAIN')).toBe('AUTH PLAIN');
    expect(r.authInProgress).toBe(true);
    expect(r.redactIncoming(PLAIN)).toBe('[redacted]');
    expect(r.redactIncoming('MAIL FROM:<a@b>')).toBe('[redacted]');
  });
});

// ---- Property: arbitrary chunkings and interleavings never leak the secret ----

interface ScriptLine {
  readonly client: string;
  readonly reply: string;
}

function scenario(kind: number, secret: string): ScriptLine[] {
  switch (kind) {
    case 0:
      return [{ client: `AUTH PLAIN ${secret}`, reply: '235 2.7.0 ok' }];
    case 1:
      return [
        { client: 'AUTH PLAIN', reply: '334 ' },
        { client: secret, reply: '235 2.7.0 ok' },
      ];
    case 2:
      return [
        { client: 'auth plain', reply: '334 ' },
        { client: secret, reply: '535 5.7.8 no' },
      ];
    case 3:
      return [
        { client: 'AUTH LOGIN', reply: '334 VXNlcm5hbWU6' },
        { client: 'YWxpY2U=', reply: '334 UGFzc3dvcmQ6' },
        { client: secret, reply: '235 2.7.0 ok' },
      ];
    case 4:
      return [
        { client: `AUTH XOAUTH2 ${secret}`, reply: '334 eyJzdGF0dXMiOiI0MDEifQ==' },
        { client: '', reply: '535 5.7.8 no' },
      ];
    default:
      return [
        { client: `AUTH PLAIN ${secret}`, reply: '535 5.7.8 no' },
        { client: 'AUTH LOGIN', reply: '334 VXNlcm5hbWU6' },
        { client: secret, reply: '334 UGFzc3dvcmQ6' },
        { client: secret, reply: '235 2.7.0 ok' },
      ];
  }
}

function script(kind: number, secret: string): ScriptLine[] {
  return [
    { client: 'EHLO client.example', reply: '250-mx.d3cloud.io\r\n250 AUTH PLAIN LOGIN XOAUTH2' },
    ...scenario(kind, secret),
    { client: 'MAIL FROM:<alice@d3cloud.io>', reply: '250 2.1.0 ok' },
    { client: 'RCPT TO:<bob@example.org>', reply: '250 2.1.5 ok' },
    { client: 'QUIT', reply: '221 2.0.0 bye' },
  ];
}

describe('AUTH redaction under arbitrary chunking (property, PST-REQ-117)', () => {
  it('the secret never appears in the stored text or in any published live line', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.stringMatching(/^[A-Za-z0-9+/]{12,32}={0,2}$/),
        fc.array(fc.integer({ min: 1, max: 400 }), { maxLength: 40 }),
        fc.array(fc.boolean(), { maxLength: 80 }),
        (kind, tail, cutPoints, schedule) => {
          const secret = `S3cr${tail}`;
          const lines = script(kind, secret);
          const clientBytes = lines.map((l) => `${l.client}\r\n`).join('');
          const cuts = [...new Set(cutPoints.filter((p) => p < clientBytes.length))].sort((a, b) => a - b);
          const chunks: string[] = [];
          let prev = 0;
          for (const cut of [...cuts, clientBytes.length]) {
            chunks.push(clientBytes.slice(prev, cut));
            prev = cut;
          }
          // Replies: the greeting (answers nothing), then one per client line, each written only
          // once the server has read that whole line.
          const replies = [{ needs: 0, text: '220 mx.d3cloud.io ESMTP Postroom' }, ...lines.map((l, i) => ({ needs: i + 1, text: l.reply }))];
          const h = harness();
          let readBytes = '';
          let chunkAt = 0;
          let replyAt = 0;
          let tick = 0;
          const linesRead = (): number => readBytes.split('\r\n').length - 1;
          while (chunkAt < chunks.length || replyAt < replies.length) {
            const next = replies[replyAt];
            const canReply = next !== undefined && next.needs <= linesRead();
            const preferReply = schedule[tick++ % Math.max(schedule.length, 1)] ?? true;
            if (canReply && (preferReply || chunkAt >= chunks.length)) {
              h.r.recordOutgoingRaw(Buffer.from(`${next.text}\r\n`, 'latin1'));
              replyAt++;
            } else if (chunkAt < chunks.length) {
              const chunk = chunks[chunkAt++] ?? '';
              readBytes += chunk;
              h.r.recordIncomingRaw(Buffer.from(chunk, 'latin1'));
            } else {
              break;
            }
          }
          const text = h.r.snapshotText();
          expect(text).not.toContain(secret);
          for (const line of h.published) expect(line).not.toContain(secret);
        },
      ),
      { numRuns: 500 },
    );
  });
});
