// Reverse DNS for the by-source table (PST-T-7.1): "who is 203.0.113.25?" is the first question a
// failing row raises. Bounded: only the busiest sources, one short timeout for the whole batch, and
// an in-process cache (an hour for a name, ten minutes for "none"). DELIVERABILITY_RDNS=0 turns it
// off. A lookup that fails or times out is simply `null` — the page never waits on DNS for long.
import { reverse } from 'node:dns/promises';

const cache = new Map<string, { name: string | null; until: number }>();
const HIT_MS = 3_600_000;
const MISS_MS = 600_000;

export type ReverseLookup = (ip: string) => Promise<string[]>;

export async function reverseNames(ips: readonly string[], options: { timeoutMs?: number; lookup?: ReverseLookup; now?: () => number } = {}): Promise<Map<string, string | null>> {
  const now = options.now ?? Date.now;
  const lookup = options.lookup ?? reverse;
  const out = new Map<string, string | null>();
  const pending: Promise<void>[] = [];
  for (const ip of ips) {
    const hit = cache.get(ip);
    if (hit !== undefined && hit.until > now()) {
      out.set(ip, hit.name);
      continue;
    }
    pending.push(
      lookup(ip)
        .then((names) => names[0] ?? null)
        .catch(() => null)
        .then((name) => {
          cache.set(ip, { name, until: now() + (name === null ? MISS_MS : HIT_MS) });
          out.set(ip, name);
        }),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(pending),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs ?? 1_000);
    }),
  ]);
  clearTimeout(timer);
  for (const ip of ips) if (!out.has(ip)) out.set(ip, null);
  return out;
}
