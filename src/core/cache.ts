/**
 * Tiny per-instance TTL cache with in-flight de-duplication.
 * Serverless instances are reused between requests, so this absorbs repeated pulls
 * (e.g. several questions about the same courses) without any external store.
 * Values are never persisted; they disappear when the instance is recycled.
 */
export class TtlCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    if (this.ttlMs > 0) {
      this.entries.set(key, { expires: now + this.ttlMs, value });
      // A failed load must not be cached.
      value.catch(() => this.entries.delete(key));
      this.evict();
    }
    return value;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
