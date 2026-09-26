// A tiny LRU cache with a per-entry TTL: DNSBL lookups are cached for 10 minutes per IP so a
// chatty sender does not cost a DNS round trip on every RCPT.
interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

export class TtlLru<V> {
  private readonly map = new Map<string, CacheEntry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: delete and re-insert so eviction drops the least-recently-used entry.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
