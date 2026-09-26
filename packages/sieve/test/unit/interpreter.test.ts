import { describe, expect, it } from 'vitest';
import { compileScript, execute, globMatch, matchOne, messageFromMime, SieveRuntimeError, type Budget, type VacationAction } from '../../src/index.js';
import { message, run, summarize } from './helpers.js';

const free: Budget = { charge: () => undefined };

describe('match types and comparators', () => {
  it(':matches wildcards, escapes and leftmost-shortest captures', () => {
    expect(globMatch('abc', 'a?c', free)).toEqual(['abc', 'b']);
    expect(globMatch('abc', 'a*', free)).toEqual(['abc', 'bc']);
    expect(globMatch('', '*', free)).toEqual(['', '']);
    expect(globMatch('a*c', 'a\\*c', free)).toEqual(['a*c']);
    expect(globMatch('abc', 'a\\*c', free)).toBeNull();
    expect(globMatch('a?', 'a\\?', free)).toEqual(['a?']);
    expect(globMatch('ab', 'a?c', free)).toBeNull();
    expect(globMatch('x.y.z', '*.*', free)).toEqual(['x.y.z', 'x', 'y.z']);
    expect(globMatch('😀!', '?!', free)).toEqual(['😀!', '😀']);
    expect(globMatch('aaaaaaaaaaaaaaaaaaaaaaaaaaaaab', '*a*a*a*a*a*a*c', free)).toBeNull();
  });

  it('i;ascii-casemap folds only ASCII; i;octet folds nothing', () => {
    expect(matchOne('HeLLo', 'hello', 'is', 'i;ascii-casemap', free).matched).toBe(true);
    expect(matchOne('HeLLo', 'hello', 'is', 'i;octet', free).matched).toBe(false);
    expect(matchOne('É', 'é', 'is', 'i;ascii-casemap', free).matched).toBe(false);
    const m = matchOne('Re: HELLO World', 're: * world', 'matches', 'i;ascii-casemap', free);
    expect(m.captures).toEqual(['Re: HELLO World', 'HELLO']);
    expect(matchOne('anything', '', 'contains', 'i;octet', free).matched).toBe(true);
  });

  it('the octet comparator on a header test', () => {
    expect(summarize(run('if header :comparator "i;octet" :is "subject" "HELLO" { discard; }', message({ headers: { Subject: 'hello' } })))).toEqual(['keep INBOX (implicit)']);
    expect(summarize(run('if header :comparator "i;octet" :is "subject" "hello" { discard; }', message({ headers: { Subject: 'hello' } })))).toEqual(['discard']);
  });
});

describe('tests', () => {
  it('header values are RFC 2047-decoded and multiple headers all count', () => {
    const msg = message({ headers: { Subject: '=?utf-8?B?Q2Fmw6k=?=', Received: ['from a', 'from b'] } });
    expect(summarize(run('if header :is "subject" "Café" { discard; }', msg))).toEqual(['discard']);
    expect(summarize(run('if header :contains "received" "from b" { discard; }', msg))).toEqual(['discard']);
  });

  it('address parts, groups, and non-address headers never match', () => {
    const msg = message({ headers: { To: 'Team: a@one.example, "B" <b@two.example>;', 'X-Addr': 'c@three.example' } });
    expect(summarize(run('if address :localpart :is "to" "b" { discard; }', msg))).toEqual(['discard']);
    expect(summarize(run('if address :domain :is "to" "one.example" { discard; }', msg))).toEqual(['discard']);
    expect(summarize(run('if address :contains "x-addr" "three" { discard; }', msg))).toEqual(['keep INBOX (implicit)']);
  });

  it('envelope from "<>" is the empty string', () => {
    const script = 'require "envelope"; if envelope :is "from" "" { discard; }';
    expect(summarize(run(script, message({ envelopeFrom: '' })))).toEqual(['discard']);
    expect(summarize(run('require "envelope"; if envelope :domain :is "to" "example.com" { discard; }'))).toEqual(['discard']);
  });

  it('size is strict in both directions', () => {
    const msg = message();
    expect(summarize(run(`if size :over ${msg.size} { discard; }`, msg))).toEqual(['keep INBOX (implicit)']);
    expect(summarize(run(`if size :under ${msg.size} { discard; }`, msg))).toEqual(['keep INBOX (implicit)']);
    expect(summarize(run(`if size :over ${msg.size - 1} { discard; }`, msg))).toEqual(['discard']);
  });

  it('match variables are only set by a successful :matches', () => {
    const src = `require ["variables", "fileinto"];
      if header :matches "subject" "* world" {}
      if header :is "subject" "nope" {}
      if header :matches "subject" "zzz*" {}
      fileinto "\${1}";`;
    expect(summarize(run(src, message({ headers: { Subject: 'hello world' } })))).toEqual(['fileinto hello']);
  });
});

describe('actions and the implicit keep', () => {
  it('discard with an explicit keep: the keep still happens', () => {
    expect(summarize(run('keep; discard;'))).toEqual(['keep INBOX', 'discard']);
  });

  it('fileinto the same mailbox twice files it once, merging flags; keep and fileinto INBOX are one', () => {
    const src = 'require ["fileinto", "imap4flags"]; fileinto :flags "a" "X"; fileinto :flags "b A" "X"; keep; fileinto "inbox";';
    expect(summarize(run(src))).toEqual(['fileinto X [a b]', 'keep INBOX']);
  });

  it('redirect to the same address twice redirects once; the count is capped', () => {
    expect(summarize(run('redirect "a@x.example"; redirect "A@X.example";'))).toEqual(['redirect a@x.example (refused)', 'keep INBOX (implicit)']);
    const many = Array.from({ length: 5 }, (_, i) => `redirect "r${i}@x.example";`).join('');
    const r = run(many);
    expect(r.error?.code).toBe('action-limit');
  });

  it('a refused redirect never cancels the implicit keep', () => {
    const r = run('redirect "someone@elsewhere.example"; discard;');
    // discard cancels the implicit keep on its own; the refusal is recorded either way
    expect(summarize(r)).toEqual(['redirect someone@elsewhere.example (refused)', 'discard']);
    expect(r.actions[0]).toMatchObject({ allowed: false, reason: expect.stringContaining('never relays') as unknown });
  });

  it('the implicit keep carries the internal flags', () => {
    expect(summarize(run('require "imap4flags"; addflag ["\\\\Seen", "x"]; removeflag "X";'))).toEqual(['keep INBOX [\\Seen] (implicit)']);
  });

  it('bucket: last one wins, and it does not cancel the implicit keep', () => {
    const r = run('require "vnd.postroom.bucket"; bucket "a"; bucket "Newsletters";');
    expect(r.bucket).toBe('Newsletters');
    expect(summarize(r)).toEqual(['keep INBOX (implicit)']);
  });

  it('a custom inbox name', () => {
    expect(summarize(run('keep;', message(), { inbox: 'Inbox/Primary' }))).toEqual(['keep Inbox/Primary']);
  });

  it('the trace says what happened and why', () => {
    const r = run('if header :contains "subject" "hello" { discard; }');
    expect(r.trace.map((t) => t.event)).toEqual(['header test matched', 'discard']);
    expect(r.trace[0]).toMatchObject({ line: 1, column: 4 });
  });
});

describe('vacation', () => {
  const opts = { userAddresses: ['me@example.com'] };
  const vac = (spec: Parameters<typeof message>[0], extra = {}) =>
    run('require "vacation"; vacation :handle "h1" "away";', message(spec), { ...opts, ...extra }).actions[0] as VacationAction;

  it('replies to a normal message', () => {
    expect(vac({})).toMatchObject({ respond: true, to: 'sender@example.org', handle: 'h1', days: 7 });
  });

  const suppressions: [string, Parameters<typeof message>[0], string][] = [
    ['null sender', { envelopeFrom: '' }, 'null envelope sender'],
    ['mailer-daemon', { envelopeFrom: 'MAILER-DAEMON@example.org' }, 'automated'],
    ['owner- list address', { envelopeFrom: 'owner-list@example.org' }, 'automated'],
    ['-request address', { envelopeFrom: 'list-request@example.org' }, 'automated'],
    ['Auto-Submitted', { headers: { 'Auto-Submitted': 'auto-replied' } }, 'Auto-Submitted'],
    ['List-Id', { headers: { 'List-Id': '<l.example.org>' } }, 'mailing list'],
    ['Precedence: bulk', { headers: { Precedence: 'bulk' } }, 'mailing list'],
    ['sender is me', { envelopeFrom: 'me@example.com' }, 'the account itself'],
    ['not addressed to me', { headers: { To: 'other@example.com' }, envelopeTo: 'alias@example.com' }, 'none of the account'],
  ];
  for (const [name, spec, reason] of suppressions) {
    it(`suppressed: ${name}`, () => {
      const a = vac(spec);
      expect(a.respond).toBe(false);
      expect(a.suppressed).toContain(reason);
    });
  }

  it('Auto-Submitted: no does not suppress', () => {
    expect(vac({ headers: { 'Auto-Submitted': 'no' } }).respond).toBe(true);
  });

  it('once per sender per handle, through the injected store', () => {
    const seen: [string, string, number][] = [];
    const store = {
      recentlyResponded: (sender: string, handle: string, days: number) => {
        seen.push([sender, handle, days]);
        return sender === 'sender@example.org';
      },
    };
    const a = vac({}, { vacationStore: store });
    expect(a.respond).toBe(false);
    expect(a.suppressed).toContain('within 7 days');
    expect(seen).toEqual([['sender@example.org', 'h1', 7]]);
    expect(vac({ envelopeFrom: 'new@example.org' }, { vacationStore: store }).respond).toBe(true);
  });

  it('the default handle depends on the reason, subject, from and :mime', () => {
    const h = (src: string) => (run(`require "vacation"; ${src}`, message(), opts).actions[0] as VacationAction).handle;
    expect(h('vacation "a";')).toBe(h('vacation "a";'));
    expect(h('vacation "a";')).not.toBe(h('vacation "b";'));
    expect(h('vacation "a";')).not.toBe(h('vacation :subject "s" "a";'));
    expect(h('vacation "a";')).not.toBe(h('vacation :mime "a";'));
  });

  it(':days is clamped to at least 1', () => {
    expect((run('require "vacation"; vacation :days 0 "x";', message(), opts).actions[0] as VacationAction).days).toBe(1);
  });

  it('running vacation twice is a runtime error', () => {
    const r = run('require "vacation"; vacation "a"; vacation "b";', message(), opts);
    expect(r.error?.code).toBe('duplicate-vacation');
  });
});

describe('variables', () => {
  it('names are case-insensitive, unknown ones are empty, values are not re-expanded', () => {
    const src = `require ["variables", "fileinto"];
      set "d" "$";
      set "A" "\${d}{b}";
      set "b" "x";
      fileinto "[\${a}][\${B}][\${nope}]";`;
    expect(summarize(run(src))).toEqual(['fileinto [${b}][x][]']);
  });

  it('expansion is capped', () => {
    const src = `require ["variables", "fileinto"];
      set "a" "0123456789";
      set "a" "\${a}\${a}\${a}\${a}\${a}\${a}\${a}\${a}\${a}\${a}";
      set "a" "\${a}\${a}\${a}\${a}\${a}\${a}\${a}\${a}\${a}\${a}";
      fileinto "\${a}";`;
    const r = run(src, message(), { maxStringLength: 500 });
    expect(r.actions[0]).toMatchObject({ type: 'fileinto' });
    expect((r.actions[0] as { mailbox: string }).mailbox).toHaveLength(500);
  });

  it(':length counts characters, not code units', () => {
    expect(summarize(run('require ["variables", "fileinto"]; set :length "n" "😀é"; fileinto "${n}";'))).toEqual(['fileinto 2']);
  });
});

describe('runtime errors fall back to the implicit keep', () => {
  it('an expanded redirect address that is invalid', () => {
    const r = run('require "variables"; set "to" "not valid"; redirect "${to}"; discard;');
    expect(r.error).toBeInstanceOf(SieveRuntimeError);
    expect(r.error?.line).toBe(1);
    expect(summarize(r)).toEqual(['keep INBOX (implicit)']);
    expect(r.trace.at(-1)?.event).toContain('falling back to the implicit keep');
  });

  it('an expanded bucket name that is invalid', () => {
    const r = run('require ["variables", "vnd.postroom.bucket"]; bucket "${x}";');
    expect(r.error?.code).toBe('bad-value');
    expect(r.bucket).toBeNull();
  });

  it('the work limit stops a pathological :matches', () => {
    const script = compileScript(`if header :matches "subject" "*${'a'.repeat(200)}b" { discard; }`, {});
    const r = execute(script, message({ headers: { Subject: 'a'.repeat(5000) } }), { maxWork: 100_000 });
    expect(r.error?.code).toBe('work-limit');
    expect(summarize(r)).toEqual(['keep INBOX (implicit)']);
  });

  it('the action limit', () => {
    const src = `require "fileinto"; ${Array.from({ length: 10 }, (_, i) => `fileinto "m${i}";`).join(' ')}`;
    expect(run(src, message(), { maxActions: 5 }).error?.code).toBe('action-limit');
  });
});

describe('messageFromMime', () => {
  it('headers, size, raw body and decoded parts', () => {
    const raw = 'From: a@b.example\r\nSubject: x\r\nContent-Type: multipart/alternative; boundary=z\r\n\r\n--z\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9\r\n--z\r\nContent-Type: text/html\r\n\r\n<b>hi</b>\r\n--z--\r\n';
    const m = messageFromMime(raw, { from: 'a@b.example', to: 'c@d.example' });
    expect(m.size).toBe(Buffer.byteLength(raw));
    expect(m.header('SUBJECT')).toEqual(['x']);
    expect(m.header('nope')).toEqual([]);
    expect(m.rawBody().startsWith('--z\r\n')).toBe(true);
    expect(m.bodyParts().map((p) => [p.contentType, p.content])).toEqual([
      ['text/plain', 'café'],
      ['text/html', '<b>hi</b>'],
    ]);
  });

  it('caps each part', () => {
    const m = messageFromMime(`Subject: x\r\n\r\n${'a'.repeat(5000)}`, { from: '', to: 'x@y.example' }, { maxPartChars: 100, maxRawChars: 50 });
    expect(m.bodyParts()[0]?.content).toHaveLength(100);
    expect(m.rawBody()).toHaveLength(50);
  });
});
