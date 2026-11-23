import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { OperationJournal, type JournalRecord } from "../../packages/worker/src/journal.js";
import { CloseRetentionExecutor } from "../../packages/worker/src/close-retention.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "close-retention-protocol-")); roots.push(root);
  const journal = new OperationJournal(root);
  const generation = { sessionGeneration: 3, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const seal = { filesystemId: randomUUID(), backingId: "42:5", deviceId: "7:1" };
  let sealed = false;
  let currentGeneration = structuredClone(generation);
  let tail = Promise.resolve();
  const storage = {
    identity: async () => currentGeneration,
    successor: vi.fn(async () => { currentGeneration = { ...generation, dataGeneration: randomUUID() }; return currentGeneration; }),
    withOwnership: async <T>(_mode: "read" | "write", work: () => Promise<T>): Promise<T> => {
      const previous = tail; let release!: () => void; tail = new Promise<void>((r) => { release = r; });
      await previous; try { return await work(); } finally { release(); }
    },
    seal: vi.fn(async () => { sealed = true; return seal; }),
    verify: vi.fn(async () => sealed),
  };
  const inspect = vi.fn(async () => ({ safeToClose: true, repositories: [], contentDigest: "a".repeat(64) }));
  const invocation: WorkerInvocation = { protocolVersion: 1, kind: "close", operationId: randomUUID(), workspaceId: randomUUID(), fence: 9, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { schemaVersion: 1, action: "retain", target: generation } };
  let otherActive = false;
  const executor = () => new CloseRetentionExecutor(journal, storage, inspect, () => otherActive);
  return { root, journal, generation, seal, storage, inspect, invocation, executor, setOtherActive: (active: boolean) => { otherActive = active; } };
}

describe("worker completed retention authority", () => {
  it("seals before inspection, fences same/lower writers, and replays the same saved result after restart", async () => {
    const h = await fixture();
    const first = await h.executor().answer(h.invocation);
    expect(first.status).toBe("retained");
    expect(h.storage.seal.mock.invocationCallOrder[0]).toBeLessThan(h.inspect.mock.invocationCallOrder[0]!);
    for (const fence of [8, 9]) {
      await expect(h.journal.accept({ ...h.invocation, kind: "resume", operationId: randomUUID(), fence, payload: {} })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    }
    expect(await h.executor().answer({ ...h.invocation, callbackCapability: "renewed".repeat(10) })).toEqual(first);
    expect(h.inspect).toHaveBeenCalledTimes(1);
  });
  it("verifies after a fresh executor with zero journal, inspection or seal writes", async () => {
    const h = await fixture(); const first = await h.executor().answer(h.invocation);
    if (first.status !== "retained") throw new Error("retention fixture failed");
    const names = await readdir(h.journal.directory);
    const before = await Promise.all(names.filter((p) => p.endsWith(".json")).map((p) => readFile(join(h.journal.directory, p), "utf8")));
    h.inspect.mockClear(); h.storage.seal.mockClear();
    const queryId = randomUUID();
    const result = await h.executor().answer({ ...h.invocation, operationId: randomUUID(), fence: 10, payload: { schemaVersion: 1, action: "verify", retention: first.retention, queryId } });
    expect(result).toMatchObject({ status: "verified", verified: true, queryId, retention: first.retention });
    expect(await Promise.all(names.filter((p) => p.endsWith(".json")).map((p) => readFile(join(h.journal.directory, p), "utf8")))).toEqual(before);
    expect(await readdir(h.journal.directory)).toEqual(names);
    expect(h.inspect).not.toHaveBeenCalled(); expect(h.storage.seal).not.toHaveBeenCalled();
  });
  it("publishes no proof when the kernel seal cannot be established", async () => {
    const h = await fixture(); h.storage.seal.mockRejectedValue(new Error("remount busy"));
    expect(await h.executor().answer(h.invocation)).toMatchObject({ status: "unavailable", reason: "unproven" });
    expect(h.inspect).not.toHaveBeenCalled();
    await expect(h.journal.accept({ ...h.invocation, kind: "resume", operationId: randomUUID(), payload: {} })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("never upgrades a successful legacy record into authoritative retention", async () => {
    const h = await fixture(); await h.journal.accept({ ...h.invocation, payload: {} });
    await h.journal.transition(h.invocation.operationId, "SUCCEEDED");
    await expect(h.executor().answer(h.invocation)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(h.inspect).not.toHaveBeenCalled();
  });
});


it("a newer signed writer acquires a distinct generation while the original remains sealed", async () => {
  const h = await fixture(); const executor = h.executor(); const first = await executor.answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const writer: WorkerInvocation = { ...h.invocation, kind: "task", operationId: randomUUID(), fence: 10,
    payload: { conversationId: randomUUID(), prompt: "new work" }, supersedesRetention: first.retention };
  const accepted = await executor.admitWriter(writer);
  expect(accepted.duplicate).toBe(false);
  expect((await h.storage.identity()).dataGeneration).not.toBe(first.retention.generation.dataGeneration);
  expect(h.storage.successor).toHaveBeenCalledOnce();
  expect((await h.journal.get(h.invocation.operationId))?.closeRetention).toMatchObject({ phase: "sealed", supersededBy: writer.operationId, terminalReply: first });
  await expect(h.journal.accept({ ...writer, operationId: randomUUID(), fence: 9, supersedesRetention: undefined })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(await executor.answer({ ...h.invocation, operationId: randomUUID(), fence: 10, payload: { schemaVersion: 1, action: "verify", queryId: randomUUID(), retention: first.retention } })).toMatchObject({ status: "verified", verified: false });
});

it("withholds proof when the completed kernel guard is false", async () => {
  const h = await fixture(); h.storage.verify.mockResolvedValue(false);
  expect(await h.executor().answer(h.invocation)).toMatchObject({ status: "unavailable", reason: "unproven" });
  expect(h.inspect).not.toHaveBeenCalled();
  expect((await h.journal.get(h.invocation.operationId))?.closeRetention?.terminalReply).toBeUndefined();
});

it("does not expire retained ownership or destroy authorization through clock changes or pruning", async () => {
  const h = await fixture(); const first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const destroy: WorkerInvocation = { ...h.invocation, operationId: randomUUID(), fence: 10, payload: { schemaVersion: 1, action: "destroy", retention: first.retention, effectId: "close:destroy", machineIds: ["machine"] } };
  const authorized = await h.executor().answer(destroy);
  expect(authorized).toMatchObject({ status: "destroy_authorized", effectId: "close:destroy" });
  expect(await h.journal.pruneTombstones(0, Date.now() + 100 * 365 * 86_400_000)).toBe(0);
  expect(await h.executor().answer({ ...destroy, callbackCapability: "refresh".repeat(10) })).toEqual(authorized);
  await expect(h.executor().answer({ ...destroy, payload: { schemaVersion: 1, action: "destroy", retention: first.retention, effectId: "other", machineIds: ["machine"] } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("two journals sharing the host ownership lock cannot publish competing retentions", async () => {
  const h = await fixture();
  const second = new CloseRetentionExecutor(new OperationJournal(h.root), h.storage, h.inspect, () => false);
  const results = await Promise.allSettled([h.executor().answer(h.invocation), second.answer({ ...h.invocation, operationId: randomUUID() })]);
  expect(results.filter((r) => r.status === "fulfilled" && r.value.status === "retained")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(h.inspect).toHaveBeenCalledOnce();
});


it.each(["version", "command", "generation"] as const)("returns unproven for inconsistent stored %s without repairing it", async (field) => {
  const h = await fixture(); const first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const path = join(h.journal.directory, h.invocation.operationId + ".json");
  const saved = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; closeRetention: { commandHash: string; generation: { dataGeneration: string } } };
  if (field === "version") saved.schemaVersion = 2;
  if (field === "command") saved.closeRetention.commandHash = "b".repeat(64);
  if (field === "generation") saved.closeRetention.generation.dataGeneration = randomUUID();
  await writeFile(path, JSON.stringify(saved)); const before = await readFile(path, "utf8");
  expect(await h.executor().answer({ ...h.invocation, operationId: randomUUID(), fence: 10, payload: { schemaVersion: 1, action: "verify", queryId: randomUUID(), retention: first.retention } })).toMatchObject({ status: "verified", verified: false });
  expect(await readFile(path, "utf8")).toBe(before);
});


it("withholds retention while another live executor owns a writer", async () => {
  const h = await fixture(); h.setOtherActive(true);
  expect(await h.executor().answer(h.invocation)).toMatchObject({ status: "unavailable", reason: "busy" });
  expect(h.storage.seal).not.toHaveBeenCalled(); expect(h.inspect).not.toHaveBeenCalled();
});
it.each(["sessionGeneration", "instanceId", "volumeId", "dataGeneration"] as const)("a changed live %s cannot verify or replay retained proof", async field => {
  const h = await fixture(), first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const changed = { ...h.generation, [field]: field === "sessionGeneration" ? 4 : field === "dataGeneration" ? randomUUID() : field === "instanceId" ? "i-11111111111111111" : "vol-11111111111111111" };
  h.storage.identity = async () => changed;
  const query: WorkerInvocation = { ...h.invocation, operationId: randomUUID(), payload: { schemaVersion: 1, action: "verify", retention: first.retention, queryId: randomUUID() } };
  expect(await h.executor().answer(query)).toMatchObject({ status: "verified", verified: false });
  expect(await h.executor().answer(h.invocation)).toMatchObject({ status: "unavailable", reason: "mismatch" });
  expect(h.inspect).toHaveBeenCalledOnce();
});
it.each(["command", "generation", "result"] as const)("cannot rewrite a completed retention's immutable %s", async field => {
  const h = await fixture(), first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const state = structuredClone((await h.journal.get(h.invocation.operationId))!.closeRetention!);
  if (field === "command") state.commandHash = "b".repeat(64);
  if (field === "generation") state.generation.dataGeneration = randomUUID();
  if (field === "result") {
    if (state.terminalReply?.status !== "retained") throw new Error("retention fixture failed");
    state.terminalReply.retention.contentDigest = "b".repeat(64);
    state.terminalReply.inspection.contentDigest = "b".repeat(64);
  }
  await expect(h.journal.saveRetention(h.invocation.operationId, state)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(await h.executor().answer(h.invocation)).toEqual(first);
});

it.each(["record version", "record status", "payload hash", "command hash", "generation", "phase", "seal", "reply workspace", "reply operation", "reply fence", "reply generation"] as const)("refuses a corrupted persisted %s before returning a journal record", async field => {
  const h = await fixture(), first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const path = join(h.journal.directory, h.invocation.operationId + ".json");
  const record = JSON.parse(await readFile(path, "utf8")) as JournalRecord;
  const state = record.closeRetention!, reply = state.terminalReply;
  if (reply?.status !== "retained") throw new Error("retention fixture failed");
  if (field === "record version") Object.assign(record, { schemaVersion: 2 });
  if (field === "record status") Object.assign(record, { status: "UNKNOWN" });
  if (field === "payload hash") record.payloadHash = "b".repeat(64);
  if (field === "command hash") state.commandHash = "b".repeat(64);
  if (field === "generation") state.generation.dataGeneration = randomUUID();
  if (field === "phase") state.phase = "intent";
  if (field === "seal") delete state.seal;
  if (field === "reply workspace") reply.workspaceId = randomUUID();
  if (field === "reply operation") reply.operationId = reply.retention.inspectionOperationId = randomUUID();
  if (field === "reply fence") reply.fence = reply.retention.inspectionFence = 999;
  if (field === "reply generation") reply.retention.generation.dataGeneration = randomUUID();
  await writeFile(path, JSON.stringify(record));
  const before = await readFile(path, "utf8");
  await expect(h.journal.get(h.invocation.operationId)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(before);
});

it("a terminal journal success with no completed result cannot acquire a new seal or inspection", async () => {
  const h = await fixture();
  await h.journal.accept(h.invocation); await h.journal.transition(h.invocation.operationId, "SUCCEEDED");
  expect(await h.executor().answer(h.invocation)).toMatchObject({ status: "unavailable", reason: "unproven" });
  expect(h.storage.seal).not.toHaveBeenCalled(); expect(h.inspect).not.toHaveBeenCalled();
});
it("a cancellation tombstone cannot become retention authority", async () => {
  const h = await fixture(); await h.journal.tombstone(h.invocation);
  await expect(h.executor().answer(h.invocation)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(h.storage.seal).not.toHaveBeenCalled(); expect(h.inspect).not.toHaveBeenCalled();
});
it("another workspace and a superseded inspection cannot obtain proof from a completed seal", async () => {
  const h = await fixture(), first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const query: WorkerInvocation = { ...h.invocation, operationId: randomUUID(), payload: { schemaVersion: 1, action: "verify", queryId: randomUUID(), retention: first.retention } };
  expect(await h.executor().answer({ ...query, workspaceId: randomUUID() })).toMatchObject({ status: "verified", verified: false });
  const state = (await h.journal.get(h.invocation.operationId))!.closeRetention!;
  await h.journal.saveRetention(h.invocation.operationId, { ...state, supersededBy: randomUUID() });
  expect(await h.executor().answer(query)).toMatchObject({ status: "verified", verified: false });
});

it.each(["phase", "effect", "machines", "retention"] as const)("refuses an inconsistent persisted destroy %s before returning its authorization", async field => {
  const h = await fixture(), first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const destroy: WorkerInvocation = { ...h.invocation, operationId: randomUUID(), fence: 10, payload: { schemaVersion: 1, action: "destroy", retention: first.retention, effectId: "close:destroy", machineIds: ["machine"] } };
  expect(await h.executor().answer(destroy)).toMatchObject({ status: "destroy_authorized" });
  const path = join(h.journal.directory, destroy.operationId + ".json");
  const record = JSON.parse(await readFile(path, "utf8")) as JournalRecord, state = record.closeRetention!, reply = state.terminalReply;
  if (reply?.status !== "destroy_authorized") throw new Error("destroy fixture failed");
  if (field === "phase") state.phase = "intent";
  if (field === "effect") reply.effectId = "different";
  if (field === "machines") reply.machineIds = ["different"];
  if (field === "retention") reply.retention.generation.dataGeneration = randomUUID();
  await writeFile(path, JSON.stringify(record));
  await expect(h.journal.get(destroy.operationId)).rejects.toThrow();
});

it("an incomplete intent's generation must still equal its signed command target", async () => {
  const h = await fixture(); await h.journal.accept(h.invocation);
  const path = join(h.journal.directory, h.invocation.operationId + ".json"), record = JSON.parse(await readFile(path, "utf8")) as JournalRecord;
  record.closeRetention!.generation.dataGeneration = randomUUID(); await writeFile(path, JSON.stringify(record));
  await expect(h.journal.get(h.invocation.operationId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});
it.each(["contentDigest", "retentionId"] as const)("a changed query %s cannot borrow proof from the original retention", async field => {
  const h = await fixture(), first = await h.executor().answer(h.invocation);
  if (first.status !== "retained") throw new Error("retention fixture failed");
  const retention = { ...first.retention, [field]: field === "contentDigest" ? "b".repeat(64) : randomUUID() };
  const query: WorkerInvocation = { ...h.invocation, operationId: randomUUID(), payload: { schemaVersion: 1, action: "verify", queryId: randomUUID(), retention } };
  expect(await h.executor().answer(query)).toMatchObject({ status: "verified", verified: false });
  expect(h.inspect).toHaveBeenCalledOnce();
});
it("a different live data generation refuses an initial retain before any seal or inspection", async () => {
  const h = await fixture(); h.storage.identity = async () => ({ ...h.generation, dataGeneration: randomUUID() });
  expect(await h.executor().answer(h.invocation)).toMatchObject({ status: "unavailable", reason: "mismatch" });
  expect(h.storage.seal).not.toHaveBeenCalled(); expect(h.inspect).not.toHaveBeenCalled();
});
