/**
 * Tiny per-instance TTL cache with in-flight de-duplication.
 *
 * Nothing is persisted: entries live only in this server instance's memory and vanish when
 * it is recycled. The TTL (tenant `limits.cacheTtlSeconds`, 0 = off) only avoids pulling the
 * same Moodle data twice within one conversation.
 */
export class TtlCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 20_000,
  ) {}

  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.peek<T>(key);
    if (hit) return hit;
    const value = load();
    this.set(key, value);
    return value;
  }

  /** Cached value if present and fresh. */
  peek<T>(key: string): Promise<T> | undefined {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
    if (hit) this.entries.delete(key);
    return undefined;
  }

  set<T>(key: string, value: Promise<T>): void {
    if (this.ttlMs <= 0) return;
    this.entries.set(key, { expires: Date.now() + this.ttlMs, value });
    // A failed load must not be cached.
    value.catch(() => this.entries.delete(key));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
