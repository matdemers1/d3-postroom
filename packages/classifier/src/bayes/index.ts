// Per-account naive Bayes (PST-T-5.3): tokenizer, scoring, and the pass that refines a rule decision.
export {
  countTokens,
  fromDomain,
  tokenize,
  words,
  MAX_BODY_CHARS,
  MAX_SUBJECT_CHARS,
  MAX_TOKENS,
  MAX_WORD,
  MIN_WORD,
  PRESENCE_HEADERS,
  type TokenInput,
} from './tokenize.js';
export {
  scoreBayes,
  trainingDocs,
  TOP_CONTRIBUTIONS,
  type BayesModel,
  type BayesScore,
  type BucketScore,
  type BucketTotals,
  type TokenContribution,
} from './score.js';
export {
  bayesReason,
  decideWithBayes,
  refineWithBayes,
  MIN_TRAINING_DOCS,
  type BayesDecision,
  type BayesInput,
  type RefineOptions,
} from './refine.js';
