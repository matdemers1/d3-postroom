// PST-T-2.11 in isolation: alias fan-out, per-account dedupe, plus-address tags and masked-alias
// site tags become IMAP keywords, and the keyword is always a valid atom.
//
// PST-T-5.7: a plus tag equal to a bucket name overrides the classifier's decision for that
// account's copy (PST-REQ-111).
import { describe, expect, it } from 'vitest';
import { applyTagRouting, keywordSuffix, parseRecipients, planCopies, siteKeyword, tagKeyword } from '../../src/stages/file.js';
import type { AccountDecision } from '../../src/stages/types.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

describe('planCopies', () => {
  it('fans an alias out to one copy per member account', () => {
    const plans = planCopies([{ rcpt: 'team@d3cloud.io', address: 'team@d3cloud.io', accountIds: [B, A], kind: 'alias' }]);
    expect(plans.map((p) => p.accountId)).toEqual([A, B]);
    for (const p of plans) expect(p.reasons).toEqual(['delivered via alias team@d3cloud.io (one copy per member account)']);
  });

  it('gives an account one copy however many recipients reach it, with the union of keywords', () => {
    const plans = planCopies([
      { rcpt: 'you@d3cloud.io', address: 'you@d3cloud.io', accountIds: [A], kind: 'mailbox' },
      { rcpt: 'you+github@d3cloud.io', address: 'you@d3cloud.io', accountIds: [A], kind: 'plus', tag: 'github' },
      { rcpt: 'team@d3cloud.io', address: 'team@d3cloud.io', accountIds: [A, B, A], kind: 'alias' },
    ]);
    expect(plans).toHaveLength(2);
    const a = plans.find((p) => p.accountId === A);
    expect(a?.keywords).toEqual(['$Postroom.tag.github']);
    expect(a?.tags).toEqual(['github']);
    expect(a?.reasons).toContain('tag "github" from you+github@d3cloud.io: keyword $Postroom.tag.github');
    expect(plans.find((p) => p.accountId === B)?.keywords).toEqual([]);
  });

  it('tags a masked alias with its site', () => {
    const [plan] = planCopies([{ rcpt: 'x7@d3cloud.io', address: 'x7@d3cloud.io', accountIds: [A], kind: 'masked', siteTag: 'shop.example' }]);
    expect(plan?.keywords).toEqual(['$Postroom.site.shop_example']);
  });
});

describe('keywords', () => {
  it('are IMAP atoms whatever the tag holds', () => {
    for (const tag of ['github', 'GitHub', 'a b', 'x(y)', 'q"uo\\te', '%*]{', 'news.letters', '', 'ünï']) {
      expect(keywordSuffix(tag)).toMatch(/^[a-z0-9_-]{1,64}$/);
    }
    expect(tagKeyword('GitHub')).toBe('$Postroom.tag.github');
    expect(siteKeyword('a b')).toBe('$Postroom.site.a_b');
    expect(keywordSuffix('x'.repeat(200))).toHaveLength(64);
  });
});

describe('applyTagRouting', () => {
  const peopleDecision: AccountDecision = { bucket: 'people', mailbox: 'INBOX', keyword: '$People', reasons: ['people: reason'], scores: {} };
  const junkDecision: AccountDecision = { bucket: 'junk', mailbox: 'Junk', keyword: null, reasons: ['junk: blocked'], scores: {} };

  it('routes a plus tag equal to a bucket name to that bucket, with a reason', () => {
    const routed = applyTagRouting(peopleDecision, ['receipts']);
    expect(routed.bucket).toBe('receipts');
    expect(routed.mailbox).toBe('Receipts');
    expect(routed.reasons).toContain('plus-address tag receipts');
  });

  it('matches case-insensitively', () => {
    expect(applyTagRouting(peopleDecision, ['Receipts']).bucket).toBe('receipts');
    expect(applyTagRouting(peopleDecision, ['NEWSLETTERS']).bucket).toBe('newsletters');
  });

  it('never overrides junk', () => {
    expect(applyTagRouting(junkDecision, ['receipts'])).toBe(junkDecision);
  });

  it('leaves an unrelated tag alone (keyword-only)', () => {
    expect(applyTagRouting(peopleDecision, ['github'])).toBe(peopleDecision);
  });

  it('has no bucket-matching tags to route on when there are none', () => {
    expect(applyTagRouting(peopleDecision, [])).toBe(peopleDecision);
  });
});

describe('parseRecipients', () => {
  it('reads what smtp-in writes and refuses a malformed entry rather than skipping it', () => {
    expect(parseRecipients([{ rcpt: 'you+gh@d3cloud.io', address: 'you@d3cloud.io', accountIds: [A], kind: 'plus', tag: 'gh' }])).toEqual([
      { rcpt: 'you+gh@d3cloud.io', address: 'you@d3cloud.io', accountIds: [A], kind: 'plus', tag: 'gh' },
    ]);
    expect(() => parseRecipients([{ address: 'x@d3cloud.io' }])).toThrow(/malformed/);
    expect(() => parseRecipients({})).toThrow(/not an array/);
  });
});
