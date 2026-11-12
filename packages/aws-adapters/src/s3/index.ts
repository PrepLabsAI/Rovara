// Convergence lane A3 (owner decision 72, O2): the `object-storage` port over an S3 bucket (`@rovara/aws-adapters/s3`). Generic and public: it holds no company, money or authority rule; it is the same
// layout the hosted product writes, so a bucket written by either is read by the other and no data moves.
//
// The layout, unchanged from the hosted evidence store (`aws/evidence-artifacts.ts` there):
//   - the key is the caller's key, as it is (`private/<owner>/<workspace>/evidence/<task>/<sha256>`); no prefix is added;
//   - the metadata is the object's S3 user metadata (`x-amz-meta-<name>`; the evidence store writes `sha256` and `kind`);
//   - a retention class becomes an object tag ONLY when the deployment's settings map that class to a tag (`retentionTags`: class -> { key, value }); the bucket's lifecycle rules expire
//     by those tags. The adapter names no tag itself, so no object can carry an expiry tag by accident (in particular the screenshot tag, which the hosted deployment maps from its one
//     class). A class the settings do not map gets no tag and is kept until it is deleted (the port's rule for an unknown class). The hosted deployment passes its own map, so the objects
//     it writes carry exactly the tags they carry today. The adapter never sets a lifetime itself: the bucket's rules are the one place it is decided.
//
// Write once: a `put` is `If-None-Match: *` (S3 conditional writes), so of several writers racing for a new key exactly one wins and the rest get `ObjectConflictError`. An object whose lifecycle
// expiry has passed but which S3 has not yet removed (removal runs up to a day or so later) reads as gone, and a put replaces it with `If-Match: <its ETag>`, so that replacement is also one winner.
// `overwrite: true` is a plain PUT (S3 keeps the last whole object; a reader never sees half of one).
//
// Errors never carry S3's own words (they can name the bucket or the key): a refusal is one of the port's errors, and anything else is `S3ObjectStorageError` with a fixed sentence.
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { ObjectConflictError, ObjectMetaError, ObjectTooBigError, assertObjectKey, assertObjectMeta, assertObjectPrefix, type ObjectMeta, type ObjectPutOptions, type ObjectStat, type ObjectStorage } from "@agentx/contracts";

/** The largest object one PUT may carry (S3's own limit). */
export const S3_SINGLE_PUT_MAX_BYTES = 5 * 1_024 * 1_048_576;
export const S3_OBJECT_DEFAULT_MAX_BYTES = 256 * 1_048_576;
/** S3 keeps at most 2 KB of user metadata (names and values, as UTF-8); the port's `OBJECT_METADATA_LIMITS.bytes` is the same number. */
export const S3_METADATA_MAX_BYTES = 2_048;
/** A presigned read lives at most this long. The hosted evidence download uses 60 seconds. */
export const S3_PRESIGN_MAX_SECONDS = 300;
export const S3_PRESIGN_DEFAULT_SECONDS = 60;
/**
 * The content types a read link may show in the browser (`inline`): pictures and video, which a browser never runs as a page. Any other type (text, HTML, SVG, JSON, PDF, archives) is always
 * served as a download (`attachment`), whatever the caller asked, so a stored file can never render as a page on the bucket's address.
 */
export const S3_INLINE_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "video/webm", "video/mp4"]);

/** S3 lower-cases metadata names, so only lower-case names come back as they were written; values are printable ASCII (S3 re-encodes anything else). */
const METADATA_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const METADATA_VALUE = /^[\x20-\x7e]*$/u;
/** A tag value S3 accepts: letters, digits and `+ - = . _ : / @`. */
const RETENTION_CLASS = /^[A-Za-z0-9+\-=._:/@]{1,128}$/u;
const DELETE_ROUNDS = 100;
const PUT_ATTEMPTS = 3;

/** The commands this adapter sends. A real `S3Client` is one; tests give a faithful fake. */
export type S3ObjectCommand = PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand | DeleteObjectsCommand | ListObjectsV2Command;
export interface S3ObjectClient {
  send(command: S3ObjectCommand): Promise<unknown>;
}

/** Signs a GET for one key. Matches `getSignedUrl` of `@aws-sdk/s3-request-presigner`, which a deployment passes in (Code does not depend on it). */
export type S3PresignFunction = (client: S3ObjectClient, command: GetObjectCommand, options: { expiresIn: number }) => Promise<string>;

export class S3ObjectStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3ObjectStorageError";
  }
}

export interface S3ObjectStorageOptions {
  client: S3ObjectClient;
  bucket: string;
  /** The account that must own the bucket (`ExpectedBucketOwner`): a request to a bucket of another account fails instead of writing there. */
  expectedBucketOwner?: string;
  /** Default 256 MiB; at most 5 GiB (one PUT). */
  maxObjectBytes?: number;
  /** Reads an object's lifecycle expiry against this clock. */
  now?: () => number;
  /** Needed only for `presignGet`. */
  presign?: S3PresignFunction;
  /**
   * Which retention classes get an object tag, and which: class -> { key, value }, each an S3 tag (key up to 128, value up to 256 of letters, digits and `+ - = . _ : / @`). Absent or
   * empty: no object is tagged, so the bucket's tag rules expire nothing this adapter writes.
   */
  retentionTags?: Readonly<Record<string, S3RetentionTag>>;
}

/** The object tag a retention class is written with. */
export interface S3RetentionTag {
  key: string;
  value: string;
}

const TAG_KEY = /^[A-Za-z0-9+\-=._:/@]{1,128}$/u;
const TAG_VALUE = /^[A-Za-z0-9+\-=._:/@]{0,256}$/u;

type Output = { ETag?: string; ContentLength?: number; Metadata?: Record<string, string>; Expiration?: string; Body?: { transformToByteArray(): Promise<Uint8Array>; destroy?: () => void } };

const statusOf = (error: unknown): number | undefined => {
  const meta = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata;
  return typeof meta?.httpStatusCode === "number" ? meta.httpStatusCode : undefined;
};
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "");
const isMissing = (error: unknown): boolean => ["NoSuchKey", "NotFound"].includes(nameOf(error)) || statusOf(error) === 404;
/** 412: the condition failed (the key is taken, or the ETag moved). 409: S3 refused one of two conditional writes that ran at once. Both mean another writer won. */
const isConflict = (error: unknown): boolean => ["PreconditionFailed", "ConditionalRequestConflict"].includes(nameOf(error)) || statusOf(error) === 412 || statusOf(error) === 409;
const unavailable = (what: string): S3ObjectStorageError => new S3ObjectStorageError(`the object store could not ${what} (S3 refused or did not answer)`);

/**
 * When the bucket's lifecycle rule ends this object, from S3's `x-amz-expiration` (`expiry-date="Fri, 21 Dec 2012 00:00:00 GMT", rule-id="..."`), or undefined when no rule applies.
 * A header that does not parse is treated as "no expiry", never as "expired": an object is kept rather than lost on a format change.
 */
export function s3ExpiryOf(expiration: string | undefined): number | undefined {
  const date = /expiry-date="([^"]+)"/u.exec(expiration ?? "")?.[1];
  if (date === undefined) return undefined;
  const at = Date.parse(date);
  return Number.isFinite(at) ? at : undefined;
}

/** The tag set of a write in the URL-encoded form S3 takes: the class's mapped tag, or undefined when the settings map no tag for the class. */
export function s3RetentionTagging(retention: string, tags: Readonly<Record<string, S3RetentionTag>> | undefined): string | undefined {
  const tag = tags !== undefined && Object.hasOwn(tags, retention) ? tags[retention] : undefined;
  return tag === undefined ? undefined : `${encodeURIComponent(tag.key)}=${encodeURIComponent(tag.value)}`;
}

function assertS3Meta(meta: ObjectMeta): void {
  assertObjectMeta(meta);
  let bytes = 0;
  for (const [name, value] of Object.entries(meta.metadata)) {
    if (!METADATA_NAME.test(name)) throw new ObjectMetaError("an S3 object's metadata names are lower-case letters, digits and . _ - (S3 lower-cases names)");
    if (!METADATA_VALUE.test(value)) throw new ObjectMetaError("an S3 object's metadata values are printable ASCII");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (bytes > S3_METADATA_MAX_BYTES) throw new ObjectMetaError("an S3 object's metadata is at most 2 KB");
  if (!RETENTION_CLASS.test(meta.retention)) throw new ObjectMetaError("a retention class is 1 to 128 letters, digits or + - = . _ : / @ (the settings may map it to an S3 tag)");
  if (!METADATA_VALUE.test(meta.contentType)) throw new ObjectMetaError("an object's content type is printable ASCII");
}

export class S3ObjectStorage implements ObjectStorage {
  readonly #client: S3ObjectClient;
  readonly #bucket: string;
  readonly #owner: { ExpectedBucketOwner?: string };
  readonly #maxBytes: number;
  readonly #now: () => number;
  readonly #presign: S3PresignFunction | undefined;
  readonly #tags: Readonly<Record<string, S3RetentionTag>>;

  constructor(options: S3ObjectStorageOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucket)) throw new S3ObjectStorageError("an S3 bucket name is 3 to 63 lower-case letters, digits, dots and hyphens");
    if (options.expectedBucketOwner !== undefined && !/^\d{12}$/u.test(options.expectedBucketOwner)) throw new S3ObjectStorageError("the expected bucket owner is a 12-digit AWS account id");
    const max = options.maxObjectBytes ?? S3_OBJECT_DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(max) || max < 1 || max > S3_SINGLE_PUT_MAX_BYTES) throw new S3ObjectStorageError("the largest object is 1 byte to 5 GiB");
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#owner = options.expectedBucketOwner === undefined ? {} : { ExpectedBucketOwner: options.expectedBucketOwner };
    this.#maxBytes = max;
    this.#now = options.now ?? Date.now;
    this.#presign = options.presign;
    const tags: Record<string, S3RetentionTag> = {};
    for (const [retention, tag] of Object.entries(options.retentionTags ?? {})) {
      if (!RETENTION_CLASS.test(retention) || !TAG_KEY.test(tag.key) || !TAG_VALUE.test(tag.value)) throw new S3ObjectStorageError("a retention tag maps a retention class to an S3 tag key and value of plain characters");
      tags[retention] = { key: tag.key, value: tag.value };
    }
    this.#tags = Object.freeze(tags);
  }

  #expired(output: Output): boolean {
    const at = s3ExpiryOf(output.Expiration);
    return at !== undefined && at <= this.#now();
  }

  async #send(command: S3ObjectCommand): Promise<Output> {
    return (await this.#client.send(command)) as Output;
  }

  async put(key: string, bytes: Uint8Array, meta: ObjectMeta, options?: ObjectPutOptions): Promise<void> {
    assertObjectKey(key);
    assertS3Meta(meta);
    if (bytes.byteLength > this.#maxBytes) throw new ObjectTooBigError(bytes.byteLength, this.#maxBytes);
    // A tag only for a class the settings map (see the header): this adapter names no tag of its own.
    const tagging = s3RetentionTagging(meta.retention, this.#tags);
    const input: PutObjectCommandInput = {
      Bucket: this.#bucket, Key: key, Body: bytes, ContentLength: bytes.byteLength, ContentType: meta.contentType, Metadata: { ...meta.metadata }, ...this.#owner,
      ...(tagging === undefined ? {} : { Tagging: tagging }),
    };
    if (options?.overwrite === true) {
      try { await this.#send(new PutObjectCommand(input)); } catch { throw unavailable("store the object"); }
      return;
    }
    let condition: { IfNoneMatch: "*" } | { IfMatch: string } = { IfNoneMatch: "*" };
    for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
      try {
        await this.#send(new PutObjectCommand({ ...input, ...condition }));
        return;
      } catch (error) {
        // `If-Match` on a key that went away meanwhile: the key is free again, so try the write-once form.
        if ("IfMatch" in condition && isMissing(error)) { condition = { IfNoneMatch: "*" }; continue; }
        if (!isConflict(error)) throw unavailable("store the object");
      }
      // Taken. It is still free if what holds it has expired and S3 has not removed it yet: replace exactly that object (by its ETag), so one writer wins this too.
      const head = await this.#head(key);
      if (head === undefined) { condition = { IfNoneMatch: "*" }; continue; }
      if (!this.#expired(head) || head.ETag === undefined) throw new ObjectConflictError(key);
      condition = { IfMatch: head.ETag };
    }
    throw new ObjectConflictError(key);
  }

  async #head(key: string): Promise<Output | undefined> {
    try {
      return await this.#send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key, ...this.#owner }));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw unavailable("read the object's details");
    }
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array | undefined> {
    assertObjectKey(key);
    let output: Output;
    try {
      output = await this.#send(new GetObjectCommand({ Bucket: this.#bucket, Key: key, ...this.#owner }));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw unavailable("read the object");
    }
    const length = output.ContentLength;
    if (this.#expired(output) || !Number.isSafeInteger(length) || length! > maxBytes || output.Body === undefined) {
      // Never cut, never read what will not be returned.
      output.Body?.destroy?.();
      return undefined;
    }
    let bytes: Uint8Array;
    try { bytes = await output.Body.transformToByteArray(); } catch { throw unavailable("read the object"); }
    return bytes.byteLength === length ? bytes : undefined;
  }

  async stat(key: string): Promise<ObjectStat | undefined> {
    assertObjectKey(key);
    const head = await this.#head(key);
    if (head === undefined || this.#expired(head) || !Number.isSafeInteger(head.ContentLength)) return undefined;
    return { bytes: head.ContentLength!, metadata: { ...(head.Metadata ?? {}) } };
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.#send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key, ...this.#owner }));
    } catch (error) {
      if (isMissing(error)) return;
      throw unavailable("delete the object");
    }
  }

  async deletePrefix(prefix: string): Promise<boolean> {
    assertObjectPrefix(prefix);
    for (let round = 0; round < DELETE_ROUNDS; round += 1) {
      let listed: { Contents?: { Key?: string }[] };
      try {
        listed = (await this.#client.send(new ListObjectsV2Command({ Bucket: this.#bucket, Prefix: prefix, MaxKeys: 1_000, ...this.#owner }))) as typeof listed;
      } catch { throw unavailable("list the objects to delete"); }
      const keys = (listed.Contents ?? []).map((item) => item.Key).filter((key): key is string => typeof key === "string" && key.startsWith(prefix));
      if (keys.length === 0) return true;
      try {
        await this.#client.send(new DeleteObjectsCommand({ Bucket: this.#bucket, Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true }, ...this.#owner }));
      } catch { throw unavailable("delete the objects"); }
    }
    return false;
  }

  /**
   * A short-lived read link for ONE key, answered with the content type given and a disposition: `inline` only for a picture or video type (`S3_INLINE_CONTENT_TYPES`), else always `attachment`
   * (so a stored file is never rendered as a page by the bucket). Not part of the port: a caller that serves
   * downloads by link (a large video or trace) and has checked the reader's right to the object asks for it. The link lives `expiresInSeconds` (default 60, at most 300). It does not check the object exists.
   */
  async presignGet(key: string, options: { contentType: string; disposition: "inline" | "attachment"; expiresInSeconds?: number }): Promise<string> {
    assertObjectKey(key);
    const seconds = options.expiresInSeconds ?? S3_PRESIGN_DEFAULT_SECONDS;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > S3_PRESIGN_MAX_SECONDS) throw new S3ObjectStorageError("a read link lives 1 to 300 seconds");
    if (options.contentType === "" || options.contentType.length > 200 || !METADATA_VALUE.test(options.contentType)) throw new S3ObjectStorageError("a read link names a content type");
    if (options.disposition !== "inline" && options.disposition !== "attachment") throw new S3ObjectStorageError("a read link is inline or attachment");
    if (this.#presign === undefined) throw new S3ObjectStorageError("read links are not set up for this object store");
    const disposition = options.disposition === "inline" && S3_INLINE_CONTENT_TYPES.has(options.contentType.toLowerCase()) ? "inline" : "attachment";
    try {
      return await this.#presign(this.#client, new GetObjectCommand({ Bucket: this.#bucket, Key: key, ResponseContentType: options.contentType, ResponseContentDisposition: disposition, ...this.#owner }), { expiresIn: seconds });
    } catch { throw unavailable("sign a read link"); }
  }
}
