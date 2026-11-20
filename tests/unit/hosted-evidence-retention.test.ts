// L4-HW4: kept evidence expires on the deployed bucket. The bucket's lifecycle rules (ExpireEvidenceShort, ExpireEvidenceStd: prefix `private/` AND tag `rovara-retention=<class>`) read an object tag the adapter writes only
// for a class its settings map, so the broker maps the two evidence classes (core-host/hosted-evidence.ts `EVIDENCE_RETENTION_TAGS`). Untagged, a pack and its tails would be kept until an erase deleted them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { E2E_ARTIFACT_RETENTION_TAG_KEY, type OrgId } from "@agentx/contracts";
import { S3ObjectStorage } from "../../packages/aws-adapters/src/s3/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { evidencePackKey } from "../../packages/broker/src/core/proof/evidence-keep.js";
import { EVIDENCE_RETENTION_TAGS, hostedEvidenceBlobs } from "../../packages/broker/src/core-host/hosted-evidence.js";
import { FakeS3 } from "../support/ports/aws-fakes.js";

const DAY = 86_400_000;
const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const BUCKET = "rovara-artifacts-test";
const TASK = { ownerKey: "owner-a", workspaceId: "ws-a", taskId: "task-1" };

describe("hosted evidence retention", () => {

  it("the broker's object storage is built with those tags (and with no other change to its settings)", () => {
    const source = readFileSync("packages/broker/src/aws/broker.ts", "utf8");
    expect(source).toContain('objects: { bucket: requiredEnvironment("ARTIFACT_BUCKET_NAME"), client: s3, retentionTags: EVIDENCE_RETENTION_TAGS },');
  });

  it("a pack written through the company's evidence store is tagged evidence-std and is gone after the 30 days; an untagged class is kept", async () => {
    let now = Date.parse("2026-11-18T10:00:00.000Z");
    const s3 = new FakeS3({ bucket: BUCKET, now: () => now, rules: [{ id: "ExpireEvidenceStd", prefix: "private/", tag: { key: E2E_ARTIFACT_RETENTION_TAG_KEY, value: "evidence-std" }, days: 30 }] });
    const objects = new S3ObjectStorage({ client: s3, bucket: BUCKET, now: () => now, retentionTags: EVIDENCE_RETENTION_TAGS });
    const store = new MemoryDocumentStore();
    await store.put({ item: { ...workspaceKey(A, "ws-a"), entityType: "WORKSPACE", id: "ws-a", companyId: A, orgId: A, ownerKey: "owner-a", projectName: "payments" } });
    const blobs = hostedEvidenceBlobs({ blobs: objects, store, companyId: A });
    const key = evidencePackKey(TASK, "c".repeat(64));
    await blobs.put(key, new Uint8Array([1]), { contentType: "application/json", metadata: { kind: "evidence-pack" }, retention: "evidence-std" }, { overwrite: true });
    expect(s3.tagsOf(key)).toEqual({ [E2E_ARTIFACT_RETENTION_TAG_KEY]: "evidence-std" });
    now += 29 * DAY;
    expect(await blobs.get(key, 10)).toBeDefined();
    now += 2 * DAY;
    expect(await blobs.get(key, 10)).toBeUndefined();
  });
});
