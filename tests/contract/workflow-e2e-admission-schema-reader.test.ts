import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { E2EWorkflowAdmissionRef } from "@agentx/contracts";
import { createWorkflowE2EAdmissionSchemaReader } from "../../packages/broker/src/aws/workflow-e2e-admission-schema.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const referenceFor = (bytes: Buffer, override: Partial<E2EWorkflowAdmissionRef["admissionRef"]> = {}): E2EWorkflowAdmissionRef => ({ schemaVersion: 1, taskId: "11111111-1111-4111-8111-111111111111",
  workflowRevision: 3, candidateDigest: "a".repeat(64), roundId: "22222222-2222-4222-8222-222222222222", groupRunIds: ["33333333-3333-4333-8333-333333333333"],
  admissionRef: { key: `workflow-e2e-admissions/sha256/${sha(bytes)}.json`, sha256: sha(bytes), byteLength: bytes.byteLength, ...override } });
const s3Returning = (text: string | Error) => ({ send: vi.fn(async () => { if (text instanceof Error) throw text; return { Body: { transformToString: async () => text } }; }) });

describe("the admission schema reader the dispatcher uses", () => {
  it("answers the schemaVersion of an admission whose bytes match the reference's content address", async () => {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-application-admission/v1", more: "x" }));
    const s3 = s3Returning(bytes.toString("utf8"));
    const reader = createWorkflowE2EAdmissionSchemaReader({ s3, bucket: "artifacts" });
    await expect(reader(referenceFor(bytes))).resolves.toBe("workflow-e2e-application-admission/v1");
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it("answers undefined for an object that is missing, changed, the wrong size, or not JSON with a string schemaVersion", async () => {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: "workflow-e2e-admission/v1" }));
    await expect(createWorkflowE2EAdmissionSchemaReader({ s3: s3Returning(new Error("NoSuchKey")), bucket: "b" })(referenceFor(bytes))).resolves.toBeUndefined();
    await expect(createWorkflowE2EAdmissionSchemaReader({ s3: s3Returning(JSON.stringify({ schemaVersion: "other" })), bucket: "b" })(referenceFor(bytes))).resolves.toBeUndefined();
    await expect(createWorkflowE2EAdmissionSchemaReader({ s3: s3Returning(bytes.toString("utf8")), bucket: "b" })(referenceFor(bytes, { byteLength: bytes.byteLength + 1 }))).resolves.toBeUndefined();
    const notJson = Buffer.from("not json");
    await expect(createWorkflowE2EAdmissionSchemaReader({ s3: s3Returning("not json"), bucket: "b" })(referenceFor(notJson))).resolves.toBeUndefined();
    const noSchema = Buffer.from(JSON.stringify({ schemaVersion: 4 }));
    await expect(createWorkflowE2EAdmissionSchemaReader({ s3: s3Returning(noSchema.toString("utf8")), bucket: "b" })(referenceFor(noSchema))).resolves.toBeUndefined();
  });
});
