// DEC 212: the S3 adapter's version delete removes every stored version under a prefix (current, non-current and delete markers), by version id, and fails closed.
import { describe, expect, it } from "vitest";
import { S3ObjectStorage } from "../../packages/aws-adapters/src/s3/index.js";
import { VersionedBucket } from "../support/versioned-bucket.js";

const PREFIX = "private/owner1/ws1/evidence/task1/";

describe("S3ObjectStorage.deleteEveryVersion (DEC 212)", () => {
  it("removes the current objects, the old versions and the delete markers under the prefix, and nothing else", async () => {
    const bucket = new VersionedBucket();
    bucket.write(`${PREFIX}a`, 3);
    bucket.write(`${PREFIX}b`, 2, true);
    bucket.write("private/owner1/ws1/evidence/task10/a", 2);
    const store = new S3ObjectStorage({ client: bucket.client, bucket: "bucket-a", expectedBucketOwner: "111111111111" });
    expect(await store.deleteEveryVersion(PREFIX)).toBe(true);
    expect(bucket.versionsUnder(PREFIX)).toBe(0);
    expect(bucket.versionsUnder("private/owner1/ws1/evidence/task10/")).toBe(2);
    const deletes = bucket.sent.filter((entry) => entry.name === "DeleteObjectsCommand");
    for (const entry of deletes) for (const object of (entry.input["Delete"] as { Objects: Array<{ VersionId?: string }> }).Objects) expect(object.VersionId).toEqual(expect.any(String));
    for (const entry of bucket.sent) expect(entry.input["ExpectedBucketOwner"]).toBe("111111111111");
  });

  it("pages through a long listing with its markers", async () => {
    const bucket = new VersionedBucket();
    bucket.pageSize = 2;
    for (let i = 0; i < 5; i += 1) bucket.write(`${PREFIX}k${String(i)}`, 2);
    expect(await new S3ObjectStorage({ client: bucket.client, bucket: "bucket-a" }).deleteEveryVersion(PREFIX)).toBe(true);
    expect(bucket.versionsUnder(PREFIX)).toBe(0);
  });

  it("answers false when a batch delete reports a per-key error, and never true", async () => {
    const bucket = new VersionedBucket();
    bucket.write(`${PREFIX}a`, 2);
    bucket.failKeys.add(`${PREFIX}a`);
    expect(await new S3ObjectStorage({ client: bucket.client, bucket: "bucket-a" }).deleteEveryVersion(PREFIX)).toBe(false);
    // It stops at the first reported error: one listing, one batch delete, no rounds spent repeating it.
    expect(bucket.sent.map((entry) => entry.name)).toEqual(["ListObjectVersionsCommand", "DeleteObjectsCommand"]);
  });

  it("never deletes a key outside the prefix, whatever the listing returns", async () => {
    const bucket = new VersionedBucket();
    const outside = ["private", "owner1", "ws1", "evidence", "other", "x"].join("/");
    bucket.write(outside, 1);
    bucket.rawListing = { Versions: [{ Key: outside, VersionId: "v1" }, { Key: `${PREFIX}a`, VersionId: "v9" }], IsTruncated: false };
    await new S3ObjectStorage({ client: bucket.client, bucket: "bucket-a" }).deleteEveryVersion(PREFIX);
    const named = bucket.sent.filter((entry) => entry.name === "DeleteObjectsCommand").flatMap((entry) => (entry.input["Delete"] as { Objects: Array<{ Key: string }> }).Objects.map((object) => object.Key));
    expect(named).toEqual([`${PREFIX}a`]);
    expect(bucket.versionsUnder("private/owner1/ws1/evidence/other/")).toBe(1);
  });

  it("throws (fixed words, no key) when a listing cannot be read: an entry without a version id, or a truncated page without markers", async () => {
    const store = (raw: unknown) => { const bucket = new VersionedBucket(); bucket.rawListing = raw; return new S3ObjectStorage({ client: bucket.client, bucket: "bucket-a" }); };
    await expect(store({ Versions: [{ Key: `${PREFIX}secret-key` }] }).deleteEveryVersion(PREFIX)).rejects.toThrow(/could not read the list of versions/u);
    await expect(store({ Versions: [], IsTruncated: true }).deleteEveryVersion(PREFIX)).rejects.toThrow(/could not page the list of versions/u);
    await expect(store({ Versions: "x" }).deleteEveryVersion(PREFIX)).rejects.not.toThrow(/secret-key/u);
  });

  it("stops between list calls once the deadline passed (the first call always runs)", async () => {
    const bucket = new VersionedBucket();
    bucket.pageSize = 1;
    bucket.write(`${PREFIX}a`, 3);
    let now = 0;
    const store = new S3ObjectStorage({ client: bucket.client, bucket: "bucket-a", now: () => now });
    const first = bucket.client.send.bind(bucket.client);
    bucket.client.send = async (command: unknown) => { const answer = await first(command); now += 10; return answer; };
    expect(await store.deleteEveryVersion(PREFIX, { stopAt: 5 })).toBe("out_of_time");
    expect(bucket.versionsUnder(PREFIX)).toBeGreaterThan(0);
  });
});
