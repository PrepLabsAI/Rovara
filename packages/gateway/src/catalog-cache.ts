/** Discovered catalogs per container. A miss only costs a rediscovery; execution always rechecks the vendor. */
export class CatalogCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
