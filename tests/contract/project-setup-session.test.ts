import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProjectSetupSessionSchema, projectSetupSessionKey } from "@agentx/contracts";
import { ProjectSetupSessionManager, markProjectSetupSessionLost } from "../../packages/broker/src/aws/sessions.js";
import { projectSetupBindingDigest } from "../../packages/broker/src/aws/project-setup-runtime-catalog.js";
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

  // WORKER-DELIVERY-IDENTITY (WDI-SETUP)
  it("keeps the runtime's instance on a READY session, reads an older session without one, and never lets it outlive the address", () => {
    const base = { schemaVersion: 1 as const, setupExecutionId: randomUUID(), subjectId: randomUUID(), transportCorrelationId: randomUUID(), approvalRevision: 1, bindingDigest: "a".repeat(64), generation: 2 };
    expect(ProjectSetupSessionSchema.parse({ ...base, state: "READY", privateIp: "10.0.0.8", instanceId: "i-0123456789abcdef0" }).instanceId).toBe("i-0123456789abcdef0");
    expect(ProjectSetupSessionSchema.parse({ ...base, state: "READY", privateIp: "10.0.0.8" }).instanceId).toBeUndefined();
    expect(ProjectSetupSessionSchema.safeParse({ ...base, state: "STOPPED", instanceId: "i-0123456789abcdef0" }).success).toBe(false);
    expect(ProjectSetupSessionSchema.safeParse({ ...base, state: "READY", privateIp: "10.0.0.8", instanceId: "nope" }).success).toBe(false);
  });

  it("reads the instance back from the stored row for the delivery, and marks only the session it saw lost", async () => {
    const db = new FakeDynamoDb();
    const setupExecutionId = randomUUID();
    const key = projectSetupSessionKey(setupExecutionId);
    const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" as const };
    const subjectId = randomUUID(); const transportCorrelationId = randomUUID();
    const row = { ...key, entityType: "PROJECT_SETUP_SESSION", schemaVersion: 1, setupExecutionId, subjectId, transportCorrelationId, approvalRevision: 1, bindingDigest: projectSetupBindingDigest(binding), state: "READY", generation: 2, privateIp: "10.0.0.8", instanceId: "i-0123456789abcdef0" };
    db.set(row);
    const manager = new ProjectSetupSessionManager({ documentClient: db as never, tableName: "state" });
    const input = { setupExecutionId, subjectId, approvalRevision: 1, transportCorrelationId, binding, waitingOutboxId: randomUUID() };
    await expect(manager.ensureSession(input)).resolves.toEqual({ ready: true, generation: 2, privateIp: "10.0.0.8", instanceId: "i-0123456789abcdef0" });
    expect(await markProjectSetupSessionLost(db as never, "state", { setupExecutionId, generation: 2, instanceId: "i-0aaaaaaaaaaaaaaaa" })).toBe(false);
    expect(await markProjectSetupSessionLost(db as never, "state", { setupExecutionId, generation: 3, instanceId: "i-0123456789abcdef0" })).toBe(false);
    expect(db.get(key.pk, key.sk)).toMatchObject({ state: "READY" });
    expect(await markProjectSetupSessionLost(db as never, "state", { setupExecutionId, generation: 2, instanceId: "i-0123456789abcdef0" })).toBe(true);
    expect(db.get(key.pk, key.sk)).toMatchObject({ state: "STOPPED" });
    expect(db.get(key.pk, key.sk)).not.toHaveProperty("privateIp");
    expect(db.get(key.pk, key.sk)).not.toHaveProperty("instanceId");
    expect(ProjectSetupSessionSchema.parse(await manager.get(setupExecutionId)).state).toBe("STOPPED");
  });
});
