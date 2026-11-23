// One process-wide byte allowance, across adapters and companies. Values must be derived facts, never file bodies.
const MAX_BYTES = 16 * 1024 * 1024;
export class HeadFactMemo<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  bytes = 0;

  get(key: string): { value: T } | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: T): void {
    // UTF-16 for keys and serialized facts, plus generous map/object/array overhead.
    const bytes = 512 + 4 * (key.length + (JSON.stringify(value)?.length ?? 0)) + (Array.isArray(value) ? 128 * value.length : 0);
    const old = this.entries.get(key);
    if (old !== undefined) { this.bytes -= old.bytes; this.entries.delete(key); }
    if (bytes > MAX_BYTES) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > MAX_BYTES) {
      const oldest = this.entries.entries().next().value!;
      this.bytes -= oldest[1].bytes;
      this.entries.delete(oldest[0]);
    }
  }
}
