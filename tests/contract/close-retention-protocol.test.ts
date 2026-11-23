import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WorkerInvocationSchema, isAnsweredInvocation, CloseRetentionReplySchema, retentionInvocationDigest } from "../../packages/contracts/src/index.js";

const generation = { sessionGeneration: 3, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
const retention = { inspectionOperationId: randomUUID(), inspectionFence: 7, retentionId: randomUUID(), contentDigest: "a".repeat(64), generation };
const envelope = { protocolVersion: 1, kind: "close", workspaceId: randomUUID(), operationId: randomUUID(), fence: 8, projectRevision: 1, callbackCapability: "c".repeat(64) };
const retain = { schemaVersion: 1, action: "retain", target: generation };
const verify = { schemaVersion: 1, action: "verify", retention, queryId: randomUUID() };
const destroy = { schemaVersion: 1, action: "destroy", retention, effectId: "close:destroy", machineIds: ["ec2ws." + envelope.workspaceId] };

describe("signed close retention wire contract", () => {
  // Empty-only parsing would make the hosted retention unreachable; all-close answered classification would break legacy callbacks.
  it.each([retain, verify, destroy])("accepts a strict versioned command and answers it inline ($action)", (payload) => {
    const invocation = WorkerInvocationSchema.parse({ ...envelope, payload });
    expect(invocation.payload).toEqual(payload);
    expect(isAnsweredInvocation(invocation)).toBe(true);
  });
  it("keeps the exact legacy empty close on its callback path", () => {
    const invocation = WorkerInvocationSchema.parse({ ...envelope, payload: {} });
    expect(isAnsweredInvocation(invocation)).toBe(false);
    expect(WorkerInvocationSchema.safeParse({ ...envelope, payload: { action: "retain" } }).success).toBe(false);
  });
  it.each([
    { ...retain, schemaVersion: 2 }, { ...retain, path: "/mnt/workspace" },
    { ...retain, target: { ...generation, sessionGeneration: Number.MAX_SAFE_INTEGER + 1 } },
    { ...retain, target: { ...generation, instanceId: "../instance" } },
    { ...retain, target: { ...generation, volumeId: "/dev/nvme1" } },
    { ...verify, retention: { ...retention, contentDigest: "A".repeat(64) } },
    { ...verify, retention: { ...retention, inspectionFence: 0 } },
    { ...destroy, effectId: "x".repeat(257) }, { ...destroy, machineIds: [] },
    { ...destroy, machineIds: ["same", "same"] }, { ...destroy, machineIds: ["../other"] },
    { ...destroy, machineIds: Array.from({ length: 9 }, (_, i) => `machine-${i}`) },
    { ...destroy, machineIds: ["x".repeat(129)] },
  ])("refuses malformed identities, versions and arbitrary resource selectors %#", (payload) => {
    expect(WorkerInvocationSchema.safeParse({ ...envelope, payload }).success).toBe(false);
  });
});


it("rejects supersession selectors on read-only and close commands", () => {
  expect(WorkerInvocationSchema.safeParse({ ...envelope, supersedesRetention: retention, payload: retain }).success).toBe(false);
  expect(WorkerInvocationSchema.safeParse({ ...envelope, kind: "peek", supersedesRetention: retention, payload: {} }).success).toBe(false);
});
it("requires retained replies to agree with the inspected content and original command", () => {
  const reply = { schemaVersion: 1, action: "retain", status: "retained", workspaceId: envelope.workspaceId,
    operationId: retention.inspectionOperationId, fence: retention.inspectionFence, retention,
    inspection: { safeToClose: true, repositories: [], contentDigest: "a".repeat(64) } };
  expect(CloseRetentionReplySchema.safeParse(reply).success).toBe(true);
  expect(CloseRetentionReplySchema.safeParse({ ...reply, inspection: { ...reply.inspection, contentDigest: "b".repeat(64) } }).success).toBe(false);
  expect(CloseRetentionReplySchema.safeParse({ ...reply, operationId: randomUUID() }).success).toBe(false);
});
it("deduplicates logical selectors across renewed credentials and canonical machine sets", () => {
  const first = { ...envelope, payload: { ...destroy, machineIds: ["b", "a"] } };
  const second = { ...first, callbackCapability: "new".repeat(32), payload: { ...first.payload, machineIds: ["a", "b"] } };
  expect(retentionInvocationDigest(first)).toBe(retentionInvocationDigest(second));
  expect(retentionInvocationDigest({ ...first, payload: { ...first.payload, effectId: "other" } })).not.toBe(retentionInvocationDigest(first));
});
it("canonicalizes absent optional ordinary payload values exactly as JSON transport does", () => {
  const first = { ...envelope, kind: "task", payload: { prompt: "work", model: undefined }, supersedesRetention: retention };
  const transported = JSON.parse(JSON.stringify(first)) as typeof first;
  expect(retentionInvocationDigest(first)).toBe(retentionInvocationDigest(transported));
});
