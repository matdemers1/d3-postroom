// Per-account multinomial naive Bayes (PST-ADR-007, PST-T-5.3): explainable by construction — the
// score of a bucket is a sum of per-token terms, so the tokens that pushed a message into a bucket
// can be named in its reasons (PST-REQ-103).
//
//   log P(b | msg) ∝ log P(b) + Σ_t n_t · log P(t | b)
//   P(b)     = (docs_b + 1) / (Σ docs + |B|)                  (Laplace-smoothed prior; B = trained buckets)
//   P(t | b) = (count_{t,b} + 1) / (tokens_b + |V|)           (Laplace-smoothed likelihood)
//
// Only buckets the account has trained (docs_b > 0) are candidates, and a token the account has
// never trained into any bucket is skipped: it carries no evidence, only a length penalty.

import type { SortBucket } from '../buckets.js';
import { countTokens } from './tokenize.js';

export interface BucketTotals {
  /** Messages trained into the bucket. */
  readonly docs: number;
  /** Tokens trained into the bucket (with repeats). */
  readonly tokens: number;
}

/**
 * The part of an account's model a message needs: every bucket's totals, the counts of this
 * message's tokens, and the size of the account's vocabulary.
 */
export interface BayesModel {
  readonly buckets: ReadonlyMap<SortBucket, BucketTotals>;
  /** token → bucket → count. Absent means 0. */
  readonly counts: ReadonlyMap<string, ReadonlyMap<SortBucket, number>>;
  /** Distinct tokens the account has trained, across all buckets. */
  readonly vocabulary: number;
}

export interface BucketScore {
  readonly bucket: SortBucket;
  /** Unnormalised log posterior. */
  readonly logProb: number;
  /** Posterior probability among the candidate buckets (sums to 1). */
  readonly probability: number;
}

export interface TokenContribution {
  readonly token: string;
  /** How much this token favoured the top bucket over the runner-up, in nats (occurrences × log ratio). */
  readonly weight: number;
}

export interface BayesScore {
  /** Candidates, best first. Empty when no bucket is trained. */
  readonly ranked: readonly BucketScore[];
  readonly top: BucketScore | null;
  /** The tokens that most favoured `top` over the runner-up, strongest first (positive weights only). */
  readonly contributions: readonly TokenContribution[];
  /** Messages trained across all buckets. */
  readonly trainingDocs: number;
  /** Tokens of the message that the model knew. */
  readonly knownTokens: number;
}

export const TOP_CONTRIBUTIONS = 3;

export function trainingDocs(model: BayesModel): number {
  let n = 0;
  for (const t of model.buckets.values()) n += t.docs;
  return n;
}

export function scoreBayes(model: BayesModel, tokens: readonly string[], topN = TOP_CONTRIBUTIONS): BayesScore {
  const candidates = [...model.buckets.entries()].filter(([, t]) => t.docs > 0);
  const docs = trainingDocs(model);
  const known = [...countTokens(tokens).entries()].filter(([t]) => {
    const per = model.counts.get(t);
    if (per === undefined) return false;
    for (const c of per.values()) if (c > 0) return true;
    return false;
  });
  const knownTokens = known.reduce((s, [, n]) => s + n, 0);
  if (candidates.length === 0) return { ranked: [], top: null, contributions: [], trainingDocs: docs, knownTokens };

  const v = Math.max(model.vocabulary, 1);
  const bucketCount = candidates.length;
  const logLikelihood = (token: string, bucket: SortBucket, totals: BucketTotals): number =>
    Math.log(((model.counts.get(token)?.get(bucket) ?? 0) + 1) / (totals.tokens + v));

  const scored = candidates.map(([bucket, totals]) => {
    let logProb = Math.log((totals.docs + 1) / (docs + bucketCount));
    for (const [token, n] of known) logProb += n * logLikelihood(token, bucket, totals);
    return { bucket, logProb };
  });
  const max = Math.max(...scored.map((s) => s.logProb));
  const z = scored.reduce((s, x) => s + Math.exp(x.logProb - max), 0);
  const ranked = scored
    .map((s) => ({ ...s, probability: Math.exp(s.logProb - max) / z }))
    .sort((a, b) => b.logProb - a.logProb || a.bucket.localeCompare(b.bucket));
  const top = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;

  let contributions: TokenContribution[] = [];
  if (top !== null && runnerUp !== null) {
    const topTotals = model.buckets.get(top.bucket);
    const runnerTotals = model.buckets.get(runnerUp.bucket);
    if (topTotals !== undefined && runnerTotals !== undefined) {
      contributions = known
        .map(([token, n]) => ({
          token,
          weight: n * (logLikelihood(token, top.bucket, topTotals) - logLikelihood(token, runnerUp.bucket, runnerTotals)),
        }))
        .filter((c) => c.weight > 0)
        .sort((a, b) => b.weight - a.weight || a.token.localeCompare(b.token))
        .slice(0, topN);
    }
  }
  return { ranked, top, contributions, trainingDocs: docs, knownTokens };
}
