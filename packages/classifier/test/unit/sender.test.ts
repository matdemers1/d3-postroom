// PST-T-5.9: a transactional sender with a friendly display name and no bulk/automation header is not
// a human. Each sender-shape cue on its own, the invariants that keep real people human, and the
// filing outcome through bucketFor. None of these senders appear in fixtures/golden.
import { describe, expect, it } from 'vitest';
import { bucketFor, extractSignals, senderShape, type HeaderLike, type SignalInput } from '../../src/index.js';
import { account, AUTH_PASS, header } from './fixtures.js';

function plain(from: string, subject: string, extra: HeaderLike[] = [], acct = account()): SignalInput {
  const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return {
    headers: [header('From', from), header('To', 'me@d3cloud.io'), header('Subject', subject), ...extra],
    envelopeFrom: address,
    authVerdicts: AUTH_PASS,
    account: acct,
  };
}

function file(input: SignalInput) {
  const signals = extractSignals(input);
  return { signals, decision: bucketFor({ signals, headers: input.headers }) };
}

function shape(address: string, displayName: string, subject = '', threadReply = false) {
  return senderShape({ address, displayName, subject, threadReply });
}

describe('sender-shape cues, one at a time', () => {
  it('a role/transactional local part is a strong cue, with separators, +tags and digits', () => {
    for (const address of ['orders@x.example', 'order-confirm@x.example', 'rx_updates2@x.example', 'customer.service@x.example', 'myaccount@x.example']) {
      const s = shape(address, '');
      expect(s.transactional, address).toBe(true);
      expect(s.cues.some((c) => c.reason.startsWith(`local part "${address.split('@')[0]}"`) && c.points === 2)).toBe(true);
    }
  });

  it('a run-together local part is split into vocabulary words, but a name is not', () => {
    expect(shape('shippingupdates@x.example', '').transactional).toBe(true);
    // "billingsley" starts with "billing" but does not decompose — a surname stays a person.
    expect(shape('billingsley@x.example', '').transactional).toBe(false);
    // Given names that happen to be words are deliberately not vocabulary.
    expect(shape('bill@x.example', '').transactional).toBe(false);
  });

  it('noreply-style locals are automated whatever the separators and digits', () => {
    for (const local of ['no_reply2', 'do-not-reply', 'no.reply', 'mailer-daemon']) {
      const s = extractSignals(plain(`Somebody Nice <${local}@x.example>`, 'hi'));
      expect(s.automated.value, local).toBe(true);
      expect(s.automated.reason).toContain(local);
    }
  });

  it('a known notification/commerce domain is a strong cue', () => {
    const s = shape('someone@pagerduty.com', 'Oncall Rotation');
    expect(s.cues.some((c) => c.reason.includes('known transactional/notification sender (pagerduty.com)'))).toBe(true);
    expect(s.transactional).toBe(true);
  });

  it('a display name equal to the sending domain is an organisation', () => {
    const s = shape('hi@lanternbox.example.net', 'LanternBox');
    expect(s.cues.some((c) => c.reason.includes("sending domain's own name"))).toBe(true);
    expect(s.transactional).toBe(true);
  });

  it('organisation words and marks in a display name are a strong cue', () => {
    expect(shape('x1@wren.example', 'Wren & Moss').cues.some((c) => c.reason.includes('"&"'))).toBe(true);
    expect(shape('x1@wren.example', 'Wren Mobile').cues.some((c) => c.reason.includes('"Mobile"'))).toBe(true);
  });

  it('a sending subdomain and a transactional subject are weak cues — neither alone makes a sender non-human', () => {
    const sub = shape('kofi@notify.lark.example', '');
    expect(sub.cues.map((c) => [c.points, c.reason.includes('"notify."')])).toEqual([[1, true]]);
    expect(sub.transactional).toBe(false);
    const subj = shape('kofi@lark.example', '', 'Your password was changed');
    expect(subj.cues.map((c) => [c.points, c.reason.includes('"password"')])).toEqual([[1, true]]);
    expect(subj.transactional).toBe(false);
    // Together they are enough when nothing personal answers them.
    expect(shape('kofi@notify.lark.example', '', 'Your password was changed').transactional).toBe(true);
  });

  it('a subject cue does not count on a reply or forward', () => {
    expect(shape('a@b.example', '', 'Re: your receipt').cues).toEqual([]);
    expect(shape('a@b.example', '', 'your receipt', true).cues).toEqual([]);
  });

  it('personal evidence: "First Last" (+1) and a local part built from it (+2)', () => {
    const s = shape('t.okonkwo@b.example', 'Tobi Okonkwo');
    expect(s.personalScore).toBe(3);
    expect(s.cues.map((c) => c.reason)).toEqual([
      'display name "Tobi Okonkwo" reads as a personal name',
      'local part "t.okonkwo" is built from the display name ("okonkwo")',
    ]);
  });
});

describe('header-less transactional senders with friendly display names are not human (PST-T-5.9)', () => {
  it.each([
    ['PagerDuty <alerts@pagerduty.com>', 'Service degraded: payments-api', 'notifications'],
    ['Lanternbox <receipts@lanternbox.example.net>', 'Your Lanternbox receipt', 'receipts'],
    ['Copperline Goods <orders@copperline.example.org>', 'We received your order', 'receipts'],
    ['Heron Bank <security@heronbank.example.com>', 'New device signed in', 'updates'],
    ['Quayside Couriers <shipping-updates@quayside.example>', 'On its way to you', 'updates'],
    ['Marlin <hello@marlin.example>', 'Jo commented on your draft', 'notifications'],
    ['Kestrel Support <help@kestrel.example.io>', 'Ticket #4410 was updated', 'notifications'],
  ] as const)('%s — "%s" → %s', (from, subject, bucket) => {
    const { signals, decision } = file(plain(from, subject));
    expect(signals.human.value).toBe(false);
    expect(signals.human.reason).toMatch(/^not a human sender — sender looks transactional: transactional \d+ \[/);
    expect(decision.bucket).toBe(bucket);
    expect(decision.keyword).toBeNull();
  });
});

describe('real correspondents stay human', () => {
  it('a colleague with a display name at a company domain stays human, even on "Re: …" about an invoice', () => {
    const { signals, decision } = file(plain('Priya Raman <priya.raman@acmeworks.example.com>', 'Re: invoice for the Q3 audit', [header('In-Reply-To', '<a@d3cloud.io>')]));
    expect(signals.human.value).toBe(true);
    expect(signals.transactional.value).toBe(false);
    expect(decision.bucket).toBe('people');
  });

  it('a colleague writing from mail.<company> with a transactional-sounding subject stays human', () => {
    const { signals } = file(plain('Priya Raman <priya.raman@mail.acmeworks.example.com>', 'Your order of the slides'));
    expect(signals.human.value).toBe(true);
  });

  it('a job title or team after a personal name does not make a person an organisation', () => {
    for (const display of ['Priya Raman (Billing)', 'Priya Raman | Support Team', 'Priya Raman – Security', 'Priya Raman, Accounts']) {
      const { signals, decision } = file(plain(`${display} <priya@acmeworks.example.com>`, 'Question about the contract'));
      expect(signals.human.value, display).toBe(true);
      expect(decision.bucket, display).toBe('people');
    }
  });

  it('a reply-graph member with a role-ish address stays Priority, and says why', () => {
    const { signals, decision } = file(plain('Accounts Desk <billing@supplier.example.org>', 'Invoice 7781 attached', [], account({ replyGraph: ['billing@supplier.example.org'] })));
    expect(signals.transactional.value).toBe(true);
    expect(signals.human.value).toBe(true);
    expect(signals.human.reason).toMatch(/^known correspondent \(reply graph\) overrides transactional sender cues/);
    expect(decision).toMatchObject({ bucket: 'priority', keyword: '$Priority' });
  });

  it('a contact with a role address is Priority too; an unauthenticated VIP pin still keeps it human (People)', () => {
    expect(file(plain('Kofi Mensah <support@kofimensah.example>', 'Your laptop is ready', [], account({ contacts: ['support@kofimensah.example'] }))).decision.bucket).toBe('priority');
    const spoof = extractSignals({ ...plain('Orders <orders@x.example>', 'hi', [], account({ pins: { vip: ['orders@x.example'] } })), authVerdicts: { dmarc: { result: 'fail' } } });
    expect(spoof.human.value).toBe(true);
    expect(bucketFor({ signals: spoof, headers: [] }).bucket).toBe('people');
  });

  it('membership never rescues bulk or noreply mail', () => {
    const acct = account({ replyGraph: ['no_reply@x.example'] });
    expect(file(plain('Acme <no_reply@x.example>', 'hi', [], acct)).signals.human.value).toBe(false);
  });

  it('a person with a single first name and no transactional cues stays human (unchanged behaviour)', () => {
    const { signals, decision } = file(plain('Carol <carol@example.net>', 'hi there'));
    expect(signals.human.reason).toBe('has a personal display name ("Carol") and no transactional sender cues');
    expect(decision.bucket).toBe('people');
  });

  it('every decision records the sender-shape scores', () => {
    const { decision } = file(plain('Lanternbox <receipts@lanternbox.example.net>', 'Your Lanternbox receipt'));
    expect(decision.scores).toMatchObject({ transactional: 1, human: 0 });
    expect(decision.scores['transactionalCues']).toBeGreaterThanOrEqual(4);
    expect(decision.scores['personalCues']).toBe(0);
  });
});
