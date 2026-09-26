// PST-T-5.1: bucketFor files every message into exactly one bucket (PST-REQ-101), with non-empty
// reasons and scores (PST-REQ-103), and no LLM (PST-ADR-007).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bucketFor,
  extractSignals,
  FILING_BUCKETS,
  heuristicBucket,
  tokenize,
  type BayesModel,
  type HeaderLike,
  type SignalInput,
  type SortBucket,
} from '../../src/index.js';
import { account, AUTH_PASS, directMessage, header } from './fixtures.js';

function decideFor(input: SignalInput, model: BayesModel | null = null) {
  const signals = extractSignals(input);
  const tokens = tokenize({ headers: input.headers, from: signals.fromAddress });
  return bucketFor({ signals, headers: input.headers }, { model, tokens });
}

function bulkFrom(from: string, subject: string, extra: HeaderLike[] = []): SignalInput {
  return {
    headers: [header('From', from), header('To', 'me@d3cloud.io'), header('Subject', subject), ...extra],
    envelopeFrom: null,
    authVerdicts: AUTH_PASS,
    account: account(),
  };
}

describe('bucketFor (PST-T-5.1)', () => {
  it('a reply from someone the account wrote to is Priority, in INBOX with $Priority', () => {
    const d = decideFor(directMessage({ account: account({ replyGraph: ['jane@example.com'] }) }));
    expect(d).toMatchObject({ bucket: 'priority', folder: 'INBOX', keyword: '$Priority' });
    expect(d.reasons).toContain('sender in reply graph');
    expect(d.scores['bucket:priority']).toBe(1);
  });

  it('a first-time human is People, in INBOX with $People', () => {
    const d = decideFor(directMessage());
    expect(d).toMatchObject({ bucket: 'people', folder: 'INBOX', keyword: '$People' });
  });

  it('a newsletter (List-Id + List-Unsubscribe) goes to Newsletters', () => {
    const d = decideFor(
      bulkFrom('The Weekly <weekly@news.example.com>', 'This week in widgets', [
        header('List-Id', 'The Weekly <weekly.news.example.com>'),
        header('List-Unsubscribe', '<https://news.example.com/u>'),
      ]),
    );
    expect(d).toMatchObject({ bucket: 'newsletters', folder: 'Newsletters', keyword: null });
    expect(d.reasons).toContain('newsletters: List-Id/List-Unsubscribe present (mailing list)');
    expect(d.reasons).toContain('bayes: not enough training yet (0 of 20 moves)');
  });

  it('a receipt goes to Receipts, even from a bulk sender', () => {
    const d = decideFor(bulkFrom('Shop <no-reply@shop.example>', 'Your receipt from Shop', [header('List-Unsubscribe', '<mailto:u@shop.example>')]));
    expect(d).toMatchObject({ bucket: 'receipts', folder: 'Receipts' });
    expect(d.reasons).toContain('receipts: subject mentions "receipt"');
  });

  it('a GitHub notification goes to Notifications, not Newsletters, despite its List-Id', () => {
    const d = decideFor(
      bulkFrom('Octo Cat <notifications@github.com>', 'Re: [org/repo] Fix the thing (#12)', [
        header('List-Id', 'org/repo <repo.org.github.com>'),
        header('List-Unsubscribe', '<mailto:unsub@github.com>'),
        header('X-GitHub-Reason', 'mention'),
      ]),
    );
    expect(d).toMatchObject({ bucket: 'notifications', folder: 'Notifications' });
    expect(d.reasons).toContain('notifications: x-github-reason header (notification system)');
  });

  it('transactional security and shipping mail goes to Updates', () => {
    expect(decideFor(bulkFrom('Bank <noreply@bank.example>', 'New sign-in to your account')).bucket).toBe('updates');
    expect(decideFor(bulkFrom('Carrier <info@carrier.example>', 'Your package has shipped', [header('Feedback-ID', 'c1:carrier')])).bucket).toBe('updates');
  });

  it('Auto-Submitted mail with no finer signal is a notification', () => {
    const d = decideFor(bulkFrom('Robot <robot@ops.example>', 'Nightly job', [header('Auto-Submitted', 'auto-generated')]));
    expect(d.bucket).toBe('notifications');
  });

  it("a trained model's choice wins over the heuristics for Other", () => {
    const input = bulkFrom('The Weekly <weekly@news.example.com>', 'digest', [header('List-Id', '<weekly.news.example.com>')]);
    const tokens = tokenize({ headers: input.headers, from: 'weekly@news.example.com' });
    const counts = new Map<string, Map<SortBucket, number>>(tokens.map((t) => [t, new Map<SortBucket, number>([['receipts', 50]])]));
    const model: BayesModel = {
      buckets: new Map([
        ['receipts', { docs: 15, tokens: 500 }],
        ['newsletters', { docs: 10, tokens: 500 }],
      ]),
      counts,
      vocabulary: 100,
    };
    const d = decideFor(input, model);
    expect(d).toMatchObject({ bucket: 'receipts', folder: 'Receipts' });
    expect(d.reasons.some((r) => r.startsWith('bayes: receipts'))).toBe(true);
    expect(d.scores['bayes:receipts']).toBeGreaterThan(0.5);
  });

  it('heuristicBucket is exposed for Other and always names a non-INBOX bucket', () => {
    const input = bulkFrom('info@corp.example', 'hello');
    expect(heuristicBucket({ signals: extractSignals(input), headers: input.headers }).bucket).toBe('updates');
  });

  it('property: any header list files into exactly one known bucket with non-empty reasons', () => {
    const headerArb = fc.record({
      name: fc.constantFrom('From', 'To', 'Cc', 'Subject', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'X-GitHub-Reason', 'Feedback-ID'),
      value: fc.string({ maxLength: 60 }),
    });
    fc.assert(
      fc.property(fc.array(headerArb, { maxLength: 8 }), fc.boolean(), (headers, known) => {
        const input: SignalInput = { headers, envelopeFrom: 'x@y.example', authVerdicts: AUTH_PASS, account: account({ replyGraph: known ? ['x@y.example'] : [] }) };
        const d = decideFor(input);
        expect(FILING_BUCKETS).toContain(d.bucket);
        expect(d.reasons.length).toBeGreaterThan(0);
        expect(d.keyword === null).toBe(d.bucket !== 'priority' && d.bucket !== 'people');
        // Deterministic.
        expect(decideFor(input)).toEqual(d);
      }),
    );
  });
});
