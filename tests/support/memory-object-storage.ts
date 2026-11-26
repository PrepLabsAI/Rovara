// An `object-storage` adapter in memory, for tests: S3's stand-in under the core host fakes and the tests that need a store for larger objects than the document store's adapter holds.
// It passes the port's conformance suite (tests/unit/ports-object-storage.test.ts): the same key, prefix and metadata rules as every adapter (the contract's own checks), objects
// immutable unless a put says overwrite, a size cap, and the evidence retention classes expiring on the given clock. It replaced the folder adapter of the retired
// `@agentx/local-adapters` (issue #1538).
import { EVIDENCE_RETENTION_DAYS, ObjectConflictError, ObjectTooBigError, assertObjectKey, assertObjectMeta, assertObjectPrefix, type ObjectMeta, type ObjectPutOptions, type ObjectStorage, type ObjectStat } from "@agentx/contracts";

const DAY_MS = 86_400_000;

export interface MemoryObjectStorageOptions {
  /** The largest object a put accepts. Default 10 MB. */
  maxObjectBytes?: number;
  now?: () => number;
  /** Days an object of a retention class is kept. Default: the evidence classes' default days; any other class is kept until it is deleted. */
  retentionDays?: Partial<Record<string, number>>;
}

interface Held { bytes: Uint8Array; metadata: Record<string, string>; expiresAt: number | undefined }

export class MemoryObjectStorage implements ObjectStorage {
  readonly #objects = new Map<string, Held>();
  readonly #maxObjectBytes: number;
  readonly #now: () => number;
  readonly #retentionDays: Partial<Record<string, number>>;

  constructor(options: MemoryObjectStorageOptions = {}) {
    this.#maxObjectBytes = options.maxObjectBytes ?? 10_000_000;
    this.#now = options.now ?? Date.now;
    this.#retentionDays = options.retentionDays ?? {};
  }

  #days(retention: string): number | undefined {
    const configured = this.#retentionDays[retention];
    if (configured !== undefined) return configured;
    return retention === "evidence-short" || retention === "evidence-std" ? EVIDENCE_RETENTION_DAYS[retention].default : undefined;
  }

  /** The object at a key, or undefined when there is none or it has expired (an expired object does not hold its key). */
  #live(key: string): Held | undefined {
    const held = this.#objects.get(key);
    if (held === undefined) return undefined;
    if (held.expiresAt !== undefined && held.expiresAt <= this.#now()) {
      this.#objects.delete(key);
      return undefined;
    }
    return held;
  }

  async put(key: string, bytes: Uint8Array, meta: ObjectMeta, options?: ObjectPutOptions): Promise<void> {
    assertObjectKey(key);
    assertObjectMeta(meta);
    if (bytes.byteLength > this.#maxObjectBytes) throw new ObjectTooBigError(bytes.byteLength, this.#maxObjectBytes);
    if (options?.overwrite !== true && this.#live(key) !== undefined) throw new ObjectConflictError(key);
    const days = this.#days(meta.retention);
    this.#objects.set(key, { bytes: Uint8Array.from(bytes), metadata: { ...meta.metadata }, expiresAt: days === undefined ? undefined : this.#now() + days * DAY_MS });
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array | undefined> {
    assertObjectKey(key);
    const held = this.#live(key);
    return held === undefined || held.bytes.byteLength > maxBytes ? undefined : Uint8Array.from(held.bytes);
  }

  async stat(key: string): Promise<ObjectStat | undefined> {
    assertObjectKey(key);
    const held = this.#live(key);
    return held === undefined ? undefined : { bytes: held.bytes.byteLength, metadata: { ...held.metadata } };
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    this.#objects.delete(key);
  }

  async deletePrefix(prefix: string): Promise<boolean> {
    assertObjectPrefix(prefix);
    for (const key of [...this.#objects.keys()]) if (key.startsWith(prefix)) this.#objects.delete(key);
    return true;
  }
}
