import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectSetupSessionKey } from "@agentx/contracts";
import { ProjectSetupSessionManager } from "../../packages/broker/src/aws/sessions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

describe("PROJECT_SETUP session storage", () => {
  it("unwraps only Dynamo key metadata before strict domain parsing", async () => {
    const db = new FakeDynamoDb();
    const setupExecutionId = randomUUID();
    const subjectId = randomUUID();
    const key = projectSetupSessionKey(setupExecutionId);
    db.set({ ...key, entityType: "PROJECT_SETUP_SESSION", schemaVersion: 1, setupExecutionId, subjectId,
      transportCorrelationId: randomUUID(), approvalRevision: 1, bindingDigest: "a".repeat(64), state: "READY", generation: 2, privateIp: "10.0.0.8" });
    const manager = new ProjectSetupSessionManager({ documentClient: db as never, tableName: "state" });
    await expect(manager.get(setupExecutionId)).resolves.toMatchObject({ setupExecutionId, subjectId, state: "READY", generation: 2 });
    await expect(manager.get(randomUUID())).resolves.toBeUndefined();
  });
});
