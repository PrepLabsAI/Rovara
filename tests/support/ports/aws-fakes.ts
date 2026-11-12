// Convergence lane A3: faithful in-memory stand-ins for the two AWS services the generic adapters use, so the adapters run their conformance suites with no AWS account.
// They answer the SDK's command objects the way the services do (as documented), including the parts the adapters depend on:
//   S3: conditional writes (`If-None-Match: *` and `If-Match: <etag>` -> 412 PreconditionFailed, `If-Match` on a missing key -> 404 NoSuchKey), user metadata names lower-cased and at
//       most 2 KB, object tags from `x-amz-tagging`, lifecycle rules by prefix and tag whose expiry is reported in `x-amz-expiration` (rounded up to the next midnight UTC) while the object
//       stays until a later sweep (as S3 removes expired objects asynchronously), ListObjectsV2 in key order with continuation, DeleteObjects, `ExpectedBucketOwner`.
//   Secrets Manager: GetSecretValue by name, ResourceNotFoundException, InvalidRequestException for a secret scheduled for deletion, AccessDeniedException, DecryptionFailure, binary secrets.
// Their error messages deliberately quote the bucket, key and secret name, as a real error can, so a test proves an adapter never passes them on.
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const DAY = 86_400_000;

export function awsError(name: string, status: number, message: string): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

interface StoredObject {
  bytes: Uint8Array;
  contentType: string | undefined;
  metadata: Record<string, string>;
  tags: Map<string, string>;
  etag: string;
  writtenAt: number;
}

export interface FakeLifecycleRule {
  id: string;
  prefix?: string;
  tag?: { key: string; value: string };
  days: number;
}

export interface FakeS3Options {
  bucket: string;
  owner?: string;
  rules?: readonly FakeLifecycleRule[];
  now?: () => number;
}

/** S3's lifecycle day count: creation time plus the days, rounded UP to the next midnight UTC. */
export function lifecycleExpiry(writtenAt: number, days: number): number {
  return (Math.floor((writtenAt + days * DAY) / DAY) + 1) * DAY;
}

export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: { command: string; input: Record<string, unknown> }[] = [];
  readonly #options: FakeS3Options;
  #etag = 0;

  constructor(options: FakeS3Options) {
    this.#options = options;
  }

  now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #rule(key: string, object: StoredObject): { rule: FakeLifecycleRule; at: number } | undefined {
    let best: { rule: FakeLifecycleRule; at: number } | undefined;
    for (const rule of this.#options.rules ?? []) {
      if (rule.prefix !== undefined && !key.startsWith(rule.prefix)) continue;
      if (rule.tag !== undefined && object.tags.get(rule.tag.key) !== rule.tag.value) continue;
      const at = lifecycleExpiry(object.writtenAt, rule.days);
      if (best === undefined || at < best.at) best = { rule, at };
    }
    return best;
  }

  #expiration(key: string, object: StoredObject): { Expiration?: string } {
    const applies = this.#rule(key, object);
    return applies === undefined ? {} : { Expiration: `expiry-date="${new Date(applies.at).toUTCString()}", rule-id="${applies.rule.id}"` };
  }

  /** What S3's lifecycle run does some time after the expiry: removes the expired objects. */
  sweep(): void {
    for (const [key, object] of this.objects) {
      const applies = this.#rule(key, object);
      if (applies !== undefined && applies.at <= this.now()) this.objects.delete(key);
    }
  }

  #check(input: { Bucket?: string | undefined; ExpectedBucketOwner?: string | undefined }): void {
    if (input.Bucket !== this.#options.bucket) throw awsError("NoSuchBucket", 404, `The specified bucket does not exist: ${String(input.Bucket)}`);
    if (input.ExpectedBucketOwner !== undefined && input.ExpectedBucketOwner !== (this.#options.owner ?? "000000000000")) throw awsError("AccessDenied", 403, `Access Denied for bucket ${String(input.Bucket)}`);
  }

  async send(command: unknown): Promise<unknown> {
    // Every call is answered on a later turn, so calls made together interleave as they would over the network; each is then atomic, as S3 is per key.
    await new Promise((resolve) => setImmediate(resolve));
    const input = (command as { input: Record<string, unknown> }).input;
    this.calls.push({ command: (command as object).constructor.name, input });
    if (command instanceof PutObjectCommand) return this.#put(command.input);
    if (command instanceof GetObjectCommand) return this.#get(command.input, true);
    if (command instanceof HeadObjectCommand) return this.#get(command.input, false);
    if (command instanceof DeleteObjectCommand) {
      this.#check(command.input);
      this.objects.delete(command.input.Key!);
      return {};
    }
    if (command instanceof DeleteObjectsCommand) {
      this.#check(command.input);
      const deleted = (command.input.Delete?.Objects ?? []).map((item) => item.Key!);
      if (deleted.length > 1_000) throw awsError("MalformedXML", 400, "too many keys");
      for (const key of deleted) this.objects.delete(key);
      return { Deleted: command.input.Delete?.Quiet === true ? [] : deleted.map((Key) => ({ Key })), Errors: [] };
    }
    if (command instanceof ListObjectsV2Command) {
      this.#check(command.input);
      const prefix = command.input.Prefix ?? "";
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const start = command.input.ContinuationToken === undefined ? 0 : Number(command.input.ContinuationToken);
      const max = command.input.MaxKeys ?? 1_000;
      const page = keys.slice(start, start + max);
      const truncated = start + max < keys.length;
      return { Contents: page.map((Key) => ({ Key, Size: this.objects.get(Key)!.bytes.byteLength })), KeyCount: page.length, IsTruncated: truncated, ...(truncated ? { NextContinuationToken: String(start + max) } : {}) };
    }
    throw new Error(`the fake S3 does not answer ${(command as object).constructor.name}`);
  }

  #put(input: PutObjectCommand["input"]): unknown {
    this.#check(input);
    const key = input.Key!;
    if (!(input.Body instanceof Uint8Array)) throw new Error("the fake S3 takes a Uint8Array body");
    const existing = this.objects.get(key);
    if (input.IfNoneMatch !== undefined) {
      if (input.IfNoneMatch !== "*") throw awsError("NotImplemented", 501, "If-None-Match takes only *");
      if (existing !== undefined) throw awsError("PreconditionFailed", 412, `At least one of the pre-conditions you specified did not hold for ${key}`);
    }
    if (input.IfMatch !== undefined) {
      if (existing === undefined) throw awsError("NoSuchKey", 404, `The specified key does not exist: ${key}`);
      if (existing.etag !== input.IfMatch) throw awsError("PreconditionFailed", 412, `At least one of the pre-conditions you specified did not hold for ${key}`);
    }
    if (input.ContentLength !== undefined && input.ContentLength !== input.Body.byteLength) throw awsError("IncompleteBody", 400, "length mismatch");
    const metadata = Object.fromEntries(Object.entries(input.Metadata ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const metaBytes = Object.entries(metadata).reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value), 0);
    if (metaBytes > 2_048) throw awsError("MetadataTooLarge", 400, `Your metadata headers exceed the maximum allowed metadata size for ${key}`);
    const tags = new Map(new URLSearchParams(input.Tagging ?? "").entries());
    if (tags.size > 10) throw awsError("InvalidTag", 400, "too many tags");
    this.#etag += 1;
    const etag = `"etag-${String(this.#etag)}"`;
    this.objects.set(key, { bytes: new Uint8Array(input.Body), contentType: input.ContentType, metadata, tags, etag, writtenAt: this.now() });
    return { ETag: etag };
  }

  #get(input: { Bucket?: string | undefined; Key?: string | undefined; ExpectedBucketOwner?: string | undefined }, body: boolean): unknown {
    this.#check(input);
    const object = this.objects.get(input.Key!);
    if (object === undefined) throw body ? awsError("NoSuchKey", 404, `The specified key does not exist: ${String(input.Key)}`) : awsError("NotFound", 404, "Not Found");
    const bytes = new Uint8Array(object.bytes);
    const head = { ContentLength: bytes.byteLength, ContentType: object.contentType, Metadata: { ...object.metadata }, ETag: object.etag, ...this.#expiration(input.Key!, object) };
    if (!body) return head;
    let destroyed = false;
    return {
      ...head,
      Body: {
        async transformToByteArray() {
          if (destroyed) throw new Error("the stream was destroyed");
          return bytes;
        },
        destroy() { destroyed = true; },
      },
    };
  }

  /** The tags S3 holds for a key. */
  tagsOf(key: string): Record<string, string> | undefined {
    const object = this.objects.get(key);
    return object === undefined ? undefined : Object.fromEntries(object.tags);
  }
}

export interface FakeSecret {
  string?: string;
  binary?: Uint8Array;
  /** Scheduled for deletion: reads are refused as an invalid request. */
  deleted?: boolean;
  /** The caller may not read it. */
  denied?: boolean;
  /** The KMS key refuses to decrypt it. */
  undecryptable?: boolean;
}

export class FakeSecretsManager {
  readonly secrets = new Map<string, FakeSecret>();
  readonly reads: string[] = [];
  /** Makes every call fail as a network or throttle failure would. */
  failing = false;

  async send(command: unknown): Promise<{ SecretString?: string; SecretBinary?: Uint8Array; Name?: string }> {
    await Promise.resolve();
    if (!(command instanceof GetSecretValueCommand)) throw new Error(`the fake Secrets Manager does not answer ${(command as object).constructor.name}`);
    const name = command.input.SecretId!;
    this.reads.push(name);
    if (this.failing) throw awsError("ThrottlingException", 400, `Rate exceeded reading ${name}`);
    const secret = this.secrets.get(name);
    if (secret === undefined) throw awsError("ResourceNotFoundException", 400, `Secrets Manager can't find the specified secret ${name}`);
    if (secret.denied === true) throw awsError("AccessDeniedException", 400, `User is not authorized to perform secretsmanager:GetSecretValue on resource ${name}`);
    if (secret.deleted === true) throw awsError("InvalidRequestException", 400, `You can't perform this operation on the secret ${name} because it was marked for deletion.`);
    if (secret.undecryptable === true) throw awsError("DecryptionFailure", 400, `Secrets Manager can't decrypt the protected secret text of ${name}`);
    return { Name: name, ...(secret.string === undefined ? {} : { SecretString: secret.string }), ...(secret.binary === undefined ? {} : { SecretBinary: secret.binary }) };
  }

  set(name: string, value: string | undefined): void {
    if (value === undefined) this.secrets.delete(name);
    else this.secrets.set(name, { string: value });
  }
}
