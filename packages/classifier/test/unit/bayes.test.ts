// PST-T-5.3 (PST-REQ-104, PST-REQ-103): the tokenizer's bounds, the naive Bayes math on a toy
// corpus, the Bayes contribution in a decision's reasons, and the not-enough-training reason.
import { describe, expect, it } from 'vitest';
import {
  bucketOfMailbox,
  decide,
  decideWithBayes,
  extractSignals,
  MAX_BODY_CHARS,
  MAX_TOKENS,
  refineWithBayes,
  scoreBayes,
  tokenize,
  trainingMove,
  type BayesModel,
  type SortBucket,
} from '../../src/index.js';
import { account, directMessage, header } from './fixtures.js';

/** The model the worker would load after training on `docs` (every token's count, not a slice). */
function train(docs: readonly (readonly [SortBucket, readonly string[]])[]): BayesModel {
  const buckets = new Map<SortBucket, { docs: number; tokens: number }>();
  const counts = new Map<string, Map<SortBucket, number>>();
  for (const [bucket, tokens] of docs) {
    const t = buckets.get(bucket) ?? { docs: 0, tokens: 0 };
    buckets.set(bucket, { docs: t.docs + 1, tokens: t.tokens + tokens.length });
    for (const token of tokens) {
      const per = counts.get(token) ?? new Map<SortBucket, number>();
      per.set(bucket, (per.get(bucket) ?? 0) + 1);
      counts.set(token, per);
    }
  }
  return { buckets, counts, vocabulary: counts.size };
}

describe('buckets', () => {
  it('maps INBOX and \\Junk by special use and the rest by exact folder name', () => {
    expect(bucketOfMailbox({ name: 'INBOX', specialUse: 'inbox' })).toBe('inbox');
    expect(bucketOfMailbox({ name: 'Spam', specialUse: 'junk' })).toBe('junk');
    expect(bucketOfMailbox({ name: 'Newsletters', specialUse: null })).toBe('newsletters');
    expect(bucketOfMailbox({ name: 'Receipts', specialUse: null })).toBe('receipts');
    expect(bucketOfMailbox({ name: 'newsletters', specialUse: null })).toBeNull();
    expect(bucketOfMailbox({ name: 'Trash', specialUse: 'trash' })).toBeNull();
    expect(bucketOfMailbox({ name: 'Newsletters', specialUse: 'archive' })).toBeNull();
  });

  it('a move is a training event only between two different buckets', () => {
    const inbox = { name: 'INBOX', specialUse: 'inbox' };
    const news = { name: 'Newsletters', specialUse: null };
    expect(trainingMove(inbox, news)).toEqual({ fromBucket: 'inbox', toBucket: 'newsletters' });
    expect(trainingMove(news, inbox)).toEqual({ fromBucket: 'newsletters', toBucket: 'inbox' });
    expect(trainingMove(inbox, { name: 'Trash', specialUse: 'trash' })).toBeNull();
    expect(trainingMove(news, news)).toBeNull();
    expect(trainingMove({ name: 'Projects', specialUse: null }, news)).toBeNull();
  });
});

describe('tokenize', () => {
  it('emits header, list, from-domain, subject and body tokens', () => {
    const tokens = tokenize({
      subject: 'Your Weekly Digest #42',
      from: 'News <news@mail.example.com>',
      bodyText: "Here's what's new this week. Unsubscribe any time.",
      headers: [header('List-Unsubscribe', '<mailto:u@example.com>'), header('List-Id', 'Weekly <weekly.example.com>'), header('Precedence', 'Bulk')],
    });
    expect(tokens).toEqual(
      expect.arrayContaining([
        'h:list-unsubscribe',
        'h:list-id',
        'h:precedence',
        'h:precedence=bulk',
        'list:weekly.example.com',
        'from:mail.example.com',
        'from:example.com',
        's:your',
        's:weekly',
        's:digest',
        "here's",
        'unsubscribe',
      ]),
    );
    expect(tokens).not.toContain('s:42');
  });

  it('never returns more than MAX_TOKENS, and header tokens survive a huge body', () => {
    const body = 'lorem ipsum dolor sit amet '.repeat(100_000);
    const tokens = tokenize({ subject: 'big', bodyText: body, headers: [header('List-Unsubscribe', '<x>')] });
    expect(tokens.length).toBeLessThanOrEqual(MAX_TOKENS);
    expect(tokens[0]).toBe('h:list-unsubscribe');
  });

  it('reads only the first MAX_BODY_CHARS of the body', () => {
    const body = `${'a'.repeat(MAX_BODY_CHARS)} sentinelword`;
    expect(tokenize({ bodyText: body })).not.toContain('sentinelword');
    expect(tokenize({ bodyText: 'x sentinelword' })).toContain('sentinelword');
  });

  it('drops one-letter, over-long and digit-only words, and is deterministic', () => {
    const input = { bodyText: `a 12345 ${'z'.repeat(41)} ok2 fine` };
    expect(tokenize(input)).toEqual(['ok2', 'fine']);
    expect(tokenize(input)).toEqual(tokenize(input));
  });
});

describe('scoreBayes', () => {
  // Two newsletters, one inbox message.
  const model = train([
    ['newsletters', ['weekly', 'digest', 'unsubscribe']],
    ['newsletters', ['weekly', 'sale']],
    ['inbox', ['lunch', 'tomorrow', 'weekly']],
  ]);

  it('matches the multinomial NB with Laplace smoothing, by hand', () => {
    const score = scoreBayes(model, ['weekly', 'digest', 'nevertrained']);
    // V = |{weekly, digest, unsubscribe, sale, lunch, tomorrow}| = 6; 'nevertrained' is skipped.
    const news = Math.log(3 / 5) + Math.log((2 + 1) / (5 + 6)) + Math.log((1 + 1) / (5 + 6));
    const inbox = Math.log(2 / 5) + Math.log((1 + 1) / (3 + 6)) + Math.log((0 + 1) / (3 + 6));
    const byBucket = new Map(score.ranked.map((s) => [s.bucket, s]));
    expect(byBucket.get('newsletters')?.logProb).toBeCloseTo(news, 10);
    expect(byBucket.get('inbox')?.logProb).toBeCloseTo(inbox, 10);
    const pNews = 1 / (1 + Math.exp(inbox - news));
    expect(score.top?.bucket).toBe('newsletters');
    expect(score.top?.probability).toBeCloseTo(pNews, 10);
    expect(score.ranked.reduce((s, r) => s + r.probability, 0)).toBeCloseTo(1, 12);
    expect(score.knownTokens).toBe(2);
    expect(score.trainingDocs).toBe(3);
  });

  it('names the tokens that favoured the winner', () => {
    const score = scoreBayes(model, ['digest', 'weekly', 'lunch']);
    expect(score.top?.bucket).toBe('newsletters');
    // 'digest' favours newsletters; 'lunch' favours inbox, so it is never a contribution.
    expect(score.contributions.map((c) => c.token)).toContain('digest');
    expect(score.contributions.map((c) => c.token)).not.toContain('lunch');
    for (const c of score.contributions) expect(c.weight).toBeGreaterThan(0);
  });

  it('an untrained model has no candidates', () => {
    const score = scoreBayes(train([]), ['weekly']);
    expect(score.top).toBeNull();
    expect(score.ranked).toEqual([]);
  });
});

describe('decideWithBayes (PST-REQ-103: reasons show the Bayes contribution)', () => {
  const newsletter = directMessage({
    headers: [
      header('From', 'Weekly <news@shop.example.com>'),
      header('To', 'me@d3cloud.io'),
      header('Subject', 'Weekly digest'),
      header('List-Unsubscribe', '<mailto:u@shop.example.com>'),
      header('Precedence', 'bulk'),
    ],
  });
  const tokens = tokenize({ headers: newsletter.headers, bodyText: 'this week sale unsubscribe' });
  const corpus: [SortBucket, string[]][] = [];
  for (let i = 0; i < 12; i++) corpus.push(['newsletters', tokenize({ subject: `Weekly digest ${i}`, from: 'news@shop.example.com', bodyText: 'sale unsubscribe', headers: [header('List-Unsubscribe', '<x>')] })]);
  for (let i = 0; i < 12; i++) corpus.push(['inbox', tokenize({ subject: `lunch plans ${i}`, from: 'jane@example.org', bodyText: 'see you tomorrow' })]);
  const model = train(corpus);

  it('appends the Bayes reason and scores to an Other decision, keeping every rule reason', () => {
    const signals = extractSignals(newsletter);
    const rules = decide(signals);
    expect(rules.bucket).toBe('other');
    const d = decideWithBayes(signals, { model, tokens });
    expect(d.refined).toBe('newsletters');
    for (const r of rules.reasons) expect(d.reasons).toContain(r);
    const reason = d.reasons.find((r) => r.startsWith('bayes: '));
    expect(reason).toMatch(/^bayes: newsletters [01]\.\d\d \(tokens: [^)]*h:list-unsubscribe[^)]*\); then inbox [01]\.\d\d$/);
    expect(d.scores['bayes:newsletters']).toBeGreaterThan(0.5);
    expect(d.scores['bayes:inbox']).toBeLessThan(0.5);
    expect(d.scores['bayes:trainingDocs']).toBe(24);
    for (const [k, v] of Object.entries(rules.scores)) expect(d.scores[k]).toBe(v);
  });

  it('says "not enough training yet" below 20 moves, and refines nothing', () => {
    const small = train(corpus.slice(0, 10).concat(corpus.slice(12, 17)));
    const d = decideWithBayes(extractSignals(newsletter), { model: small, tokens });
    expect(d.refined).toBeNull();
    expect(d.reasons).toContain('bayes: not enough training yet (15 of 20 moves)');
    const none = decideWithBayes(extractSignals(newsletter), { model: null, tokens });
    expect(none.reasons).toContain('bayes: not enough training yet (0 of 20 moves)');
  });

  it('needs two trained buckets', () => {
    const one = train(corpus.slice(0, 12).concat(corpus.slice(0, 12)));
    const d = decideWithBayes(extractSignals(newsletter), { model: one, tokens });
    expect(d.reasons).toContain('bayes: not enough training yet (1 trained bucket, need 2)');
  });

  it('rules win for Priority: the model is not consulted, and the reason says so', () => {
    const signals = extractSignals(directMessage({ account: account({ replyGraph: ['jane@example.com'] }) }));
    const d = refineWithBayes(decide(signals), { model, tokens });
    expect(d.bucket).toBe('priority');
    expect(d.refined).toBeNull();
    expect(d.reasons).toContain('bayes: not consulted; rules placed it in priority');
    expect(d.reasons.length).toBeGreaterThan(1);
  });
});
