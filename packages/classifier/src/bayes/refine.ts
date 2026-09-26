// The Bayes pass over a rule decision (PST-ADR-007, PST-REQ-103). It never removes a rule reason:
// it appends one "bayes: ..." reason and, when the model was consulted, a `bayes:<bucket>` score per
// candidate bucket.
//
//   · Rules win for Priority and People: the model is not consulted, and the reason says so.
//   · For Other, the model picks among the buckets the account has trained — but only once the
//     account has MIN_TRAINING_DOCS training moves across at least two buckets. Before that the
//     reason is "bayes: not enough training yet (n of 20 moves)" and nothing is refined.

import type { SortBucket } from '../buckets.js';
import { decide, type Decision } from '../decide.js';
import type { Signals } from '../signals.js';
import { scoreBayes, trainingDocs, type BayesModel, type BayesScore } from './score.js';

export const MIN_TRAINING_DOCS = 20;

export interface BayesInput {
  /** The account's model for this message's tokens; null when there is none. */
  readonly model: BayesModel | null;
  readonly tokens: readonly string[];
}

export interface RefineOptions {
  readonly minTrainingDocs?: number;
}

export interface BayesDecision extends Decision {
  /** The bucket the model chose for an Other decision; null when it was not consulted or not ready. */
  readonly refined: SortBucket | null;
  /** The full score, when the model was consulted. */
  readonly bayes: BayesScore | null;
}

const fmt = (p: number): string => p.toFixed(2);

/** "bayes: newsletters 0.87 (tokens: h:list-unsubscribe, weekly, digest)" */
export function bayesReason(score: BayesScore): string {
  const top = score.top;
  if (top === null) return 'bayes: no trained bucket';
  const tokens = score.contributions.map((c) => c.token);
  const why = tokens.length === 0 ? 'no distinguishing tokens' : `tokens: ${tokens.join(', ')}`;
  const others = score.ranked
    .slice(1)
    .map((s) => `${s.bucket} ${fmt(s.probability)}`)
    .join(', ');
  return `bayes: ${top.bucket} ${fmt(top.probability)} (${why})${others === '' ? '' : `; then ${others}`}`;
}

export function refineWithBayes(decision: Decision, input: BayesInput, opts: RefineOptions = {}): BayesDecision {
  const minDocs = opts.minTrainingDocs ?? MIN_TRAINING_DOCS;
  const reasons = [...decision.reasons];
  const scores = { ...decision.scores };

  if (decision.bucket !== 'other') {
    reasons.push(`bayes: not consulted; rules placed it in ${decision.bucket}`);
    return { ...decision, reasons, scores, refined: null, bayes: null };
  }

  const docs = input.model === null ? 0 : trainingDocs(input.model);
  const trainedBuckets = input.model === null ? 0 : [...input.model.buckets.values()].filter((t) => t.docs > 0).length;
  scores['bayes:trainingDocs'] = docs;
  if (input.model === null || docs < minDocs || trainedBuckets < 2) {
    const detail = docs < minDocs ? `${docs} of ${minDocs} moves` : `${trainedBuckets} trained bucket, need 2`;
    reasons.push(`bayes: not enough training yet (${detail})`);
    return { ...decision, reasons, scores, refined: null, bayes: null };
  }

  const score = scoreBayes(input.model, input.tokens);
  for (const s of score.ranked) scores[`bayes:${s.bucket}`] = Number(s.probability.toFixed(4));
  reasons.push(bayesReason(score));
  return { ...decision, reasons, scores, refined: score.top?.bucket ?? null, bayes: score };
}

/** The rule pass, then the Bayes pass. */
export function decideWithBayes(signals: Signals, input: BayesInput, opts: RefineOptions = {}): BayesDecision {
  return refineWithBayes(decide(signals), input, opts);
}
