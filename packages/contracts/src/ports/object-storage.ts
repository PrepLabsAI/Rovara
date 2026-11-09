// Port lane L9a, port S1: object storage. PROVISIONAL (owner decision 58, until Pratik agrees; see docs/ports.md).
//
// Where files live that are too big or too plain for the document store: proof evidence, plan documents, a worker's results. In
// Cloud this is an S3 bucket (objects tagged with a retention class and expired by a lifecycle rule). The shape is the one lane L7b
// wrote for evidence (`EvidenceBlobStore`), promoted to a registry point so every lane that stores a file asks the same port.
// Code's adapters: a folder on this computer (`@agentx/local-adapters/object-storage`) and, as the default, the document store. An S3
// adapter is Cloud's and is NOT here (a decision 51 item).
//
// Keys are the caller's, are case-sensitive and look like paths (`private/<owner>/<workspace>/evidence/<task>/<digest>`). A key is
// checked by `isValidObjectKey` before any adapter uses it, so no adapter ever turns a key into a place outside its own store.

/** What an object is stored with. */
export interface ObjectMeta {
  contentType: string;
  /** Small text facts about the object (its digest and kind), checked back on a stat. */
  metadata: Readonly<Record<string, string>>;
  /**
   * Names how long the object is kept. The classes are the caller's words (`evidence-std`, `evidence-short`); the adapter maps a class to
   * a number of days from its own settings, and keeps an object of an unknown class until it is deleted.
   */
  retention: string;
}

export interface ObjectStat {
  bytes: number;
  metadata: Readonly<Record<string, string>>;
}

/** What a caller may ask of a `put` beyond the object itself. */
export interface ObjectPutOptions {
  /**
   * Objects are immutable by default: a `put` on a key that already holds an object (that has not expired) throws `ObjectConflictError` and changes nothing, even when
   * two writers race for the key (exactly one wins). A caller that really means to replace an object says so with `overwrite: true`, and names why where it does.
   */
  overwrite?: true;
}

export interface ObjectStorage {
  /**
   * Stores the object. All of it is stored or none (a reader never sees half an object). An existing object is never replaced unless `options.overwrite` is set (see
   * `ObjectPutOptions`). Throws `ObjectConflictError` for a key that is taken, `ObjectTooBigError` for an object this store cannot hold, `ObjectKeyError` for a bad key and
   * `ObjectMetaError` for metadata that is too large.
   */
  put(key: string, bytes: Uint8Array, meta: ObjectMeta, options?: ObjectPutOptions): Promise<void>;
  /** The object, or undefined when there is none, it has expired, or it is bigger than `maxBytes` (never cut). */
  get(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
  /** The size and metadata the store holds for the key, or undefined (none, or expired). */
  stat(key: string): Promise<ObjectStat | undefined>;
  /** Deletes the object. Deleting what is not there is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Deletes every object whose key starts with `prefix` (a plain text prefix, as in S3: `a/b` also matches `a/bc`, so callers end a prefix
   * with `/` when they mean a folder). The prefix must not be empty. True when none is left.
   */
  deletePrefix(prefix: string): Promise<boolean>;
}

export class ObjectTooBigError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`an object of ${String(bytes)} bytes does not fit this store (${String(limit)} at most)`);
    this.name = "ObjectTooBigError";
  }
}

/** The key already holds an object and the `put` did not ask to overwrite it. Nothing was changed. */
export class ObjectConflictError extends Error {
  constructor(readonly key: string) {
    super("an object is already stored at this key (objects are immutable unless a put asks to overwrite)");
    this.name = "ObjectConflictError";
  }
}

export class ObjectKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectKeyError";
  }
}

export class ObjectMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectMetaError";
  }
}

export const OBJECT_KEY_MAX_CHARS = 1_024;
/**
 * Longest part between two slashes: 128, the same as the plain-id rule of the evidence erase (`PLAIN` in core/proof/evidence-erase.ts), so any id that erase accepts can be a part.
 * A folder adapter keeps a part as one file name of at most 255 bytes and spells a capital letter with two characters, so it refuses a part of 128 characters that is mostly capitals
 * (a lower-case id of 128 characters fits). Other adapters have no such limit.
 */
export const OBJECT_KEY_SEGMENT_MAX_CHARS = 128;
const SEGMENT = /^[A-Za-z0-9._=:@+,~-]+$/;

/**
 * Whether a key is one every adapter can keep: parts joined by `/`, each part 1 to 80 letters, digits or `. _ = : @ + , ~ -`, no part
 * that is `.` or `..`, no leading, trailing or doubled slash, at most 1024 characters.
 */
export function isValidObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > OBJECT_KEY_MAX_CHARS) return false;
  return key.split("/").every((part) => part.length <= OBJECT_KEY_SEGMENT_MAX_CHARS && part !== "." && part !== ".." && SEGMENT.test(part));
}

export function assertObjectKey(key: string): void {
  if (!isValidObjectKey(key)) throw new ObjectKeyError("an object key is parts of letters, digits and . _ = : @ + , ~ - joined by single slashes (no . or .. part)");
}

/** A prefix: a key's start. It may end in `/`, and it is never empty. */
export function assertObjectPrefix(prefix: string): void {
  const body = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (prefix === "" || !isValidObjectKey(body === "" ? "x" : body)) throw new ObjectKeyError("an object key prefix is the start of a key and is never empty");
}

/** The most small text facts an object can carry, and their size, so every adapter can keep them with the object. */
export const OBJECT_METADATA_LIMITS = { entries: 32, bytes: 4_096 } as const;

export function assertObjectMeta(meta: ObjectMeta): void {
  const entries = Object.entries(meta.metadata);
  const size = entries.reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value), 0);
  if (entries.length > OBJECT_METADATA_LIMITS.entries || size > OBJECT_METADATA_LIMITS.bytes) throw new ObjectMetaError("an object's metadata is at most 32 small text facts");
  if (meta.contentType === "" || meta.contentType.length > 200) throw new ObjectMetaError("an object has a content type of 1 to 200 characters");
}
