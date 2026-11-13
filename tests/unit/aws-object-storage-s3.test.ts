// Convergence lane A3 (owner decision 72, O2): the S3 `object-storage` adapter passes Code's conformance suite over a faithful S3 stand-in, keeps the hosted product's layout (the key as
// given, `x-amz-meta-*` metadata, the `rovara-retention` tag that the bucket's lifecycle rules read), and never passes on S3's own words.
import type { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { EVIDENCE_ARTIFACT_RETENTION, ObjectConflictError, ObjectKeyError, ObjectMetaError, ObjectTooBigError } from "@rovara-code/contracts";
import { createAdapterRegistry, loadAdapters, parsePluginConfig, type ModuleImporter } from "../../packages/core/src/ports/adapter-registry.js";
import { S3ObjectStorage, S3ObjectStorageError, S3_METADATA_MAX_BYTES, s3ExpiryOf, s3RetentionTagging, type S3ObjectClient, type S3RetentionTag } from "../../packages/aws-adapters/src/s3/index.js";
import { S3ObjectStorageSettingsSchema, s3ObjectStoragePlugin } from "../../packages/core/src/plugins/object-storage/s3/plugin.js";
import { awsError, FakeS3, lifecycleExpiry, type FakeLifecycleRule } from "../support/ports/aws-fakes.js";
import { runObjectStorageConformance } from "../support/ports/object-storage-conformance.js";

const DAY = 86_400_000;
/** The tag key the hosted bucket's rules read, as the hosted deployment would pass it in its settings (the adapter names none itself). */
const S3_RETENTION_TAG_KEY = ["rovara", "retention"].join("-");
/** The hosted deployment's map: each class it expires, written with the tag its rule reads. */
const HOSTED_TAGS: Record<string, S3RetentionTag> = Object.fromEntries(["evidence-short", "evidence-std", "e2e-screenshot"].map((retention) => [retention, { key: S3_RETENTION_TAG_KEY, value: retention }]));
const BUCKET = "rovara-artifacts-test";
/** The hosted product's lifecycle rules on its artifacts bucket (infra control-plane): by tag, evidence also by the `private/` prefix, nightly maps by prefix. */
const HOSTED_RULES: FakeLifecycleRule[] = [
  { id: "ExpireE2EScreenshots", tag: { key: S3_RETENTION_TAG_KEY, value: "e2e-screenshot" }, days: 30 },
  { id: "ExpireEvidenceShort", prefix: "private/", tag: { key: S3_RETENTION_TAG_KEY, value: "evidence-short" }, days: 14 },
  { id: "ExpireEvidenceStd", prefix: "private/", tag: { key: S3_RETENTION_TAG_KEY, value: "evidence-std" }, days: 30 },
  { id: "ExpireNightlyMaps", prefix: "nightly-maps/", days: 30 },
];
/** The conformance suite writes `evidence-std` at keys outside `private/`, so its rule here is by tag alone. */
const SUITE_RULES: FakeLifecycleRule[] = [{ id: "ExpireEvidenceStd", tag: { key: S3_RETENTION_TAG_KEY, value: "evidence-std" }, days: 30 }];

function world(options: { rules?: FakeLifecycleRule[]; maxObjectBytes?: number; owner?: string } = {}) {
  let now = Date.parse("2026-11-09T10:00:00.000Z");
  const s3 = new FakeS3({ bucket: BUCKET, rules: options.rules ?? HOSTED_RULES, now: () => now, ...(options.owner === undefined ? {} : { owner: options.owner }) });
  const store = new S3ObjectStorage({ client: s3, bucket: BUCKET, now: () => now, retentionTags: HOSTED_TAGS, ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }) });
  return { s3, store, advance: (ms: number) => { now += ms; } };
}

runObjectStorageConformance("S3 (expired objects not yet removed by S3)", {
  async create() {
    const { store, advance } = world({ rules: SUITE_RULES, maxObjectBytes: 100_000 });
    return { store, tooBigBytes: 100_001, fitsBytes: 100_000, expire: async () => { advance(32 * DAY); } };
  },
});

runObjectStorageConformance("S3 (expired objects removed by the lifecycle run)", {
  async create() {
    const { store, s3, advance } = world({ rules: SUITE_RULES, maxObjectBytes: 100_000 });
    return { store, tooBigBytes: 100_001, fitsBytes: 100_000, expire: async () => { advance(32 * DAY); s3.sweep(); } };
  },
});

describe("S3 object storage: the hosted layout", () => {
  const key = `private/owner-1/ws-1/evidence/task-1/${"a".repeat(64)}`;

  it("writes the key as given, the metadata as x-amz-meta, the content type, and the retention class as the rovara-retention tag", async () => {
    const { s3, store } = world();
    await store.put(key, new Uint8Array([1, 2, 3]), { contentType: "text/plain; charset=utf-8", metadata: { sha256: "a".repeat(64), kind: "log_txt" }, retention: "evidence-std" });
    const put = s3.calls.find((call) => call.command === "PutObjectCommand")!.input;
    expect(put).toMatchObject({ Bucket: BUCKET, Key: key, ContentType: "text/plain; charset=utf-8", Metadata: { sha256: "a".repeat(64), kind: "log_txt" }, Tagging: "rovara-retention=evidence-std", IfNoneMatch: "*" });
    expect(s3.tagsOf(key)).toEqual({ "rovara-retention": "evidence-std" });
    expect(await store.stat(key)).toEqual({ bytes: 3, metadata: { sha256: "a".repeat(64), kind: "log_txt" } });
  });

  it("tags every evidence kind the hosted map names with the tag its rule reads", () => {
    for (const retention of new Set(Object.values(EVIDENCE_ARTIFACT_RETENTION))) {
      expect(s3RetentionTagging(retention, HOSTED_TAGS)).toBe(retention in HOSTED_TAGS ? `rovara-retention=${retention}` : undefined);
    }
  });

  it("names no tag of its own: without a map, or for a class the map does not name, an object is written untagged (and kept)", async () => {
    const s3 = new FakeS3({ bucket: BUCKET, rules: HOSTED_RULES });
    const bare = new S3ObjectStorage({ client: s3, bucket: BUCKET });
    await bare.put("private/o/w/evidence/t/s", new Uint8Array([1]), { contentType: "image/jpeg", metadata: {}, retention: "e2e-screenshot" });
    expect(s3.tagsOf("private/o/w/evidence/t/s")).toEqual({});
    expect(s3.calls.find((call) => call.command === "PutObjectCommand")!.input).not.toHaveProperty("Tagging");
    const mapped = new S3ObjectStorage({ client: s3, bucket: BUCKET, retentionTags: { "evidence-std": { key: "k", value: "v" } } });
    await mapped.put("a", new Uint8Array([1]), { contentType: "a/b", metadata: {}, retention: "e2e-screenshot" });
    await mapped.put("b", new Uint8Array([1]), { contentType: "a/b", metadata: {}, retention: "evidence-std" });
    expect(s3.tagsOf("a")).toEqual({});
    expect(s3.tagsOf("b")).toEqual({ k: "v" });
    expect(() => new S3ObjectStorage({ client: s3, bucket: BUCKET, retentionTags: { "evidence-std": { key: "bad key", value: "v" } } })).toThrow(S3ObjectStorageError);
    expect(s3RetentionTagging("toString", {})).toBeUndefined();
  });

  it("leaves the lifetime to the bucket's rules: evidence-short ends after 14 days, evidence-std after 30, an unknown class never", async () => {
    const { store, advance } = world();
    const meta = (retention: string) => ({ contentType: "application/octet-stream", metadata: {}, retention });
    await store.put("private/o/w/evidence/t/short", new Uint8Array([1]), meta("evidence-short"));
    await store.put("private/o/w/evidence/t/std", new Uint8Array([2]), meta("evidence-std"));
    await store.put("private/o/w/evidence/t/kept", new Uint8Array([3]), meta("evidence-record-kept"));
    // The evidence rule needs the private/ prefix as well as the tag (the hosted rule is prefix AND tag): an evidence-std object elsewhere is kept.
    await store.put("elsewhere/std", new Uint8Array([4]), meta("evidence-std"));
    advance(15 * DAY);
    expect(await store.get("private/o/w/evidence/t/short", 10)).toBeUndefined();
    expect(await store.get("private/o/w/evidence/t/std", 10)).toBeDefined();
    advance(16 * DAY);
    expect(await store.stat("private/o/w/evidence/t/std")).toBeUndefined();
    expect(await store.get("private/o/w/evidence/t/kept", 10)).toBeDefined();
    expect(await store.get("elsewhere/std", 10)).toBeDefined();
  });

  it("reads S3's expiry header, and treats one it cannot read as no expiry (keeps the object)", () => {
    expect(s3ExpiryOf('expiry-date="Fri, 21 Dec 2012 00:00:00 GMT", rule-id="picture-deletion-rule"')).toBe(Date.parse("2012-12-21T00:00:00.000Z"));
    expect(s3ExpiryOf(undefined)).toBeUndefined();
    expect(s3ExpiryOf('expiry-date="not a date"')).toBeUndefined();
    expect(lifecycleExpiry(Date.parse("2026-11-09T10:00:00Z"), 30)).toBe(Date.parse("2026-12-10T00:00:00Z"));
  });

  it("replaces an expired object that S3 has not removed yet only by its ETag, so one writer wins", async () => {
    const { s3, store, advance } = world();
    const meta = { contentType: "text/plain", metadata: {}, retention: "evidence-short" };
    await store.put("private/o/w/evidence/t/x", new Uint8Array([1]), meta);
    advance(20 * DAY);
    const results = await Promise.allSettled([1, 2, 3, 4].map((value) => store.put("private/o/w/evidence/t/x", new Uint8Array([value + 1]), meta)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ObjectConflictError);
    expect(s3.calls.some((call) => call.command === "PutObjectCommand" && typeof call.input["IfMatch"] === "string")).toBe(true);
  });

  it("refuses metadata S3 would change or not keep, before any call", async () => {
    const { s3, store } = world();
    const meta = { contentType: "text/plain", retention: "evidence-std" };
    await expect(store.put("k", new Uint8Array(1), { ...meta, metadata: { Sha256: "x" } })).rejects.toBeInstanceOf(ObjectMetaError);
    await expect(store.put("k", new Uint8Array(1), { ...meta, metadata: { kind: "café" } })).rejects.toBeInstanceOf(ObjectMetaError);
    await expect(store.put("k", new Uint8Array(1), { ...meta, metadata: { big: "x".repeat(S3_METADATA_MAX_BYTES) } })).rejects.toBeInstanceOf(ObjectMetaError);
    await expect(store.put("k", new Uint8Array(1), { ...meta, metadata: {}, retention: "has space" })).rejects.toBeInstanceOf(ObjectMetaError);
    await expect(store.put("k", new Uint8Array(1), { ...meta, metadata: {}, retention: "x&y=z" })).rejects.toBeInstanceOf(ObjectMetaError);
    expect(s3.calls).toHaveLength(0);
  });

  it("refuses a bad key or a too-big object before any call", async () => {
    const { s3, store } = world({ maxObjectBytes: 10 });
    await expect(store.put("../x", new Uint8Array(1), { contentType: "a/b", metadata: {}, retention: "r" })).rejects.toBeInstanceOf(ObjectKeyError);
    await expect(store.put("k", new Uint8Array(11), { contentType: "a/b", metadata: {}, retention: "r" })).rejects.toBeInstanceOf(ObjectTooBigError);
    await expect(store.presignGet("a//b", { contentType: "a/b", disposition: "inline" })).rejects.toBeInstanceOf(ObjectKeyError);
    expect(s3.calls).toHaveLength(0);
  });

  it("deletes a prefix of more than one page", async () => {
    const { s3, store } = world();
    for (let index = 0; index < 2_100; index += 1) s3.objects.set(`nightly-maps/c/p/${String(index)}`, { bytes: new Uint8Array(1), contentType: "a/b", metadata: {}, tags: new Map(), etag: `"e${String(index)}"`, writtenAt: 0 });
    s3.objects.set("nightly-maps/c/q/0", { bytes: new Uint8Array(1), contentType: "a/b", metadata: {}, tags: new Map(), etag: '"q"', writtenAt: 0 });
    expect(await store.deletePrefix("nightly-maps/c/p/")).toBe(true);
    expect([...s3.objects.keys()]).toEqual(["nightly-maps/c/q/0"]);
    expect(s3.calls.filter((call) => call.command === "DeleteObjectsCommand").length).toBe(3);
  });

  it("sends the expected bucket owner on every call, so a bucket of another account is never written", async () => {
    const s3 = new FakeS3({ bucket: BUCKET, owner: "111111111111" });
    const store = new S3ObjectStorage({ client: s3, bucket: BUCKET, expectedBucketOwner: "222222222222" });
    await expect(store.put("k", new Uint8Array(1), { contentType: "a/b", metadata: {}, retention: "r" })).rejects.toBeInstanceOf(S3ObjectStorageError);
    expect(s3.objects.size).toBe(0);
    expect(s3.calls.every((call) => call.input["ExpectedBucketOwner"] === "222222222222")).toBe(true);
  });

  it("never passes on S3's own words (they quote the bucket and the key)", async () => {
    const secretKey = "private/owner-x/ws-y/evidence/t/zzz";
    const failing: S3ObjectClient = { send: async () => { throw awsError("InternalError", 500, `We encountered an internal error for ${BUCKET}/${secretKey}`); } };
    const store = new S3ObjectStorage({ client: failing, bucket: BUCKET });
    for (const attempt of [
      () => store.put(secretKey, new Uint8Array(1), { contentType: "a/b", metadata: {}, retention: "r" }),
      () => store.put(secretKey, new Uint8Array(1), { contentType: "a/b", metadata: {}, retention: "r" }, { overwrite: true }),
      () => store.get(secretKey, 10), () => store.stat(secretKey), () => store.delete(secretKey), () => store.deletePrefix("private/owner-x/"),
    ]) {
      const error = await attempt().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(S3ObjectStorageError);
      expect(String((error as Error).message)).not.toContain(BUCKET);
      expect(String((error as Error).message)).not.toContain("owner-x");
    }
  });
});

describe("S3 object storage: short-lived, scoped read links", () => {
  it("signs a GET for one key with the content type and disposition forced, for 60 seconds by default and 300 at most", async () => {
    const signed: { input: GetObjectCommand["input"]; expiresIn: number }[] = [];
    const store = new S3ObjectStorage({ client: new FakeS3({ bucket: BUCKET }), bucket: BUCKET, presign: async (_client, command, options) => { signed.push({ input: command.input, expiresIn: options.expiresIn }); return "https://signed.example.test/x"; } });
    const video = ["private", "o", "w", "evidence", "t", "v"].join("/");
    const trace = ["private", "o", "w", "evidence", "t", "z"].join("/");
    expect(await store.presignGet(video, { contentType: "video/webm", disposition: "inline" })).toBe("https://signed.example.test/x");
    await store.presignGet(trace, { contentType: "application/zip", disposition: "attachment", expiresInSeconds: 300 });
    expect(signed).toEqual([
      { input: { Bucket: BUCKET, Key: video, ResponseContentType: "video/webm", ResponseContentDisposition: "inline" }, expiresIn: 60 },
      { input: { Bucket: BUCKET, Key: trace, ResponseContentType: "application/zip", ResponseContentDisposition: "attachment" }, expiresIn: 300 },
    ]);
    // Inline only for a picture or video: anything else (HTML, SVG, text, JSON) is a download, whatever the caller asked.
    signed.length = 0;
    for (const contentType of ["text/html", "image/svg+xml", "text/plain", "application/json", "application/pdf"]) await store.presignGet(trace, { contentType, disposition: "inline" });
    await store.presignGet(video, { contentType: "IMAGE/PNG", disposition: "inline" });
    expect(signed.map((entry) => entry.input.ResponseContentDisposition)).toEqual(["attachment", "attachment", "attachment", "attachment", "attachment", "inline"]);
    for (const expiresInSeconds of [0, 301, 3_600, 1.5]) await expect(store.presignGet("k", { contentType: "a/b", disposition: "inline", expiresInSeconds })).rejects.toBeInstanceOf(S3ObjectStorageError);
    await expect(store.presignGet("k", { contentType: "a/b", disposition: "inline; filename=x" as "inline" })).rejects.toBeInstanceOf(S3ObjectStorageError);
  });

  it("says read links are not set up when no signer was given", async () => {
    const store = new S3ObjectStorage({ client: new FakeS3({ bucket: BUCKET }), bucket: BUCKET });
    await expect(store.presignGet("k", { contentType: "a/b", disposition: "inline" })).rejects.toThrow("read links are not set up");
  });
});

describe("S3 object storage: the plug-in", () => {
  const importer = (client: S3ObjectClient): ModuleImporter => async () => ({ plugin: s3ObjectStoragePlugin({ client }) });

  it("is opt-in: the config names it, and it needs exactly one AWS identity", async () => {
    expect(S3ObjectStorageSettingsSchema.safeParse({ bucket: BUCKET, region: "us-west-2" }).success).toBe(false);
    expect(S3ObjectStorageSettingsSchema.safeParse({ bucket: BUCKET, region: "us-west-2", profile: "p", roleArn: "arn:aws:iam::123456789012:role/r" }).success).toBe(false);
    expect(S3ObjectStorageSettingsSchema.safeParse({ bucket: BUCKET, region: "us-west-2", profile: "p", extra: 1 }).success).toBe(false);
    expect(S3ObjectStorageSettingsSchema.safeParse({ bucket: "Bad_Bucket", region: "us-west-2", profile: "p" }).success).toBe(false);
    const s3 = new FakeS3({ bucket: BUCKET });
    const registry = createAdapterRegistry();
    await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "object-storage", name: "s3", module: "@rovara-code/core/plugins/object-storage-s3", settings: { bucket: BUCKET, region: "us-west-2", profile: "rovara-objects", maxObjectMiB: 1, retentionTags: { "evidence-std": { key: "expiry", value: "std" } } } }] }), { registry, importModule: importer(s3) });
    const store = registry.require("object-storage");
    await store.put("k", new Uint8Array([7]), { contentType: "a/b", metadata: {}, retention: "evidence-std" });
    expect(s3.tagsOf("k")).toEqual({ expiry: "std" });
    await expect(store.put("big", new Uint8Array(1_048_577), { contentType: "a/b", metadata: {}, retention: "r" })).rejects.toBeInstanceOf(ObjectTooBigError);
  });

  it("names a bad setting without echoing its value", async () => {
    const registry = createAdapterRegistry();
    const error = await loadAdapters(parsePluginConfig({ version: 1, plugins: [{ point: "object-storage", name: "s3", module: "@rovara-code/core/plugins/object-storage-s3", settings: { bucket: "Private_Name_9", region: "us-west-2", profile: "p" } }] }), { registry, importModule: importer(new FakeS3({ bucket: BUCKET })) }).catch((caught: unknown) => caught);
    expect(String(error)).toContain("bucket");
    expect(String(error)).not.toContain("Private_Name_9");
  });
});
