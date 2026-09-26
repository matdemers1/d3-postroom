// Loads the part of an account's naive Bayes model one message needs (PST-T-5.3): every bucket's
// totals, the counts of this message's tokens, and the account's vocabulary size. For the classify
// stage to hand to @postroom/classifier's refineWithBayes; null when the account has trained nothing.
import { isSortBucket, type BayesModel, type BucketTotals, type SortBucket } from '@postroom/classifier';
import type { Db, Prisma } from '@postroom/db';

export async function loadBayesModel(db: Db | Prisma.TransactionClient, accountId: string, tokens: readonly string[]): Promise<BayesModel | null> {
  const totals = await db.$queryRaw<{ bucket: string; docs: number; tokens: number }[]>`
    SELECT bucket, docs, tokens FROM bayes_bucket_total WHERE account_id = ${accountId}::uuid AND docs > 0`;
  if (totals.length === 0) return null;
  const buckets = new Map<SortBucket, BucketTotals>();
  for (const t of totals) if (isSortBucket(t.bucket)) buckets.set(t.bucket, { docs: t.docs, tokens: t.tokens });

  const distinct = [...new Set(tokens)];
  const counts = new Map<string, Map<SortBucket, number>>();
  if (distinct.length > 0) {
    const rows = await db.$queryRaw<{ bucket: string; token: string; count: number }[]>`
      SELECT bucket, token, count FROM bayes_token WHERE account_id = ${accountId}::uuid AND token = ANY(${distinct}::text[])`;
    for (const r of rows) {
      if (!isSortBucket(r.bucket)) continue;
      const per = counts.get(r.token) ?? new Map<SortBucket, number>();
      per.set(r.bucket, r.count);
      counts.set(r.token, per);
    }
  }
  const v = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(DISTINCT token) AS n FROM bayes_token WHERE account_id = ${accountId}::uuid AND count > 0`;
  return { buckets, counts, vocabulary: Number(v[0]?.n ?? 0n) };
}
