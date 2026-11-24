// Opus review 4eda07a26 (close retention F3): the worker's journal pass over an `intent` must agree with the host helper, which treats EVERY unsuperseded
// closeRetention record (intent included) as a hold: restore() mounts the volume read-only for it and validate_boot() requires its generation to equal the
// current one (packages/worker/ec2/close-retention.sh restore / validate_boot). These tests state the helper's invariant on the journal the worker leaves.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalRetentionValue, type WorkerInvocation } from "@agentx/contracts";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { CloseRetentionExecutor } from "../../packages/worker/src/close-retention.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opus-cr3-")); roots.push(root);
  const journal = new OperationJournal(root);
  const generation = { sessionGeneration: 3, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const seal = { filesystemId: randomUUID(), backingId: "42:5", deviceId: "7:1" };
  let sealed = false, current = structuredClone(generation), tail = Promise.resolve();
  const storage = {
    identity: async () => current,
    successor: vi.fn(async () => { current = { ...generation, dataGeneration: randomUUID() }; return current; }),
    withOwnership: async <T>(_m: "read" | "write", work: () => Promise<T>): Promise<T> => { const prev = tail; let release!: () => void; tail = new Promise<void>((r) => { release = r; }); await prev; try { return await work(); } finally { release(); } },
    seal: vi.fn(async () => { sealed = true; return seal; }),
    verify: vi.fn(async () => sealed),
  };
  const inspect = vi.fn(async () => ({ safeToClose: true, repositories: [], contentDigest: "a".repeat(64) }));
  const invocation: WorkerInvocation = { protocolVersion: 1, kind: "close", operationId: randomUUID(), workspaceId: randomUUID(), fence: 9, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { schemaVersion: 1, action: "retain", target: generation } };
  const executor = () => new CloseRetentionExecutor(journal, storage, inspect, () => false);
  return { journal, storage, invocation, executor, current: () => current };
}

it("R1: after a check that never sealed, the next check (retained) and its confirmed successor, the next boot's validate_boot must still hold: every unsuperseded retention record has the CURRENT generation", async () => {
  const h = await fixture(); h.storage.seal.mockRejectedValueOnce(new Error("open writable descriptor"));
  expect(await h.executor().answer(h.invocation)).toMatchObject({ status: "unavailable" });   // C1: intent left behind
  const c2 = { ...h.invocation, operationId: randomUUID(), fence: 11 };
  const second = await h.executor().answer(c2);                                            // C2 passes the intent (new rule) and retains
  if (second.status !== "retained") throw new Error("second check did not retain");
  const step: WorkerInvocation = { ...h.invocation, kind: "task", operationId: randomUUID(), fence: 12, payload: { conversationId: randomUUID(), prompt: "continue" }, supersedesRetention: second.retention };
  await h.executor().admitWriter(step);                                                      // confirmed hand-over: generation rotates
  const held = (await h.journal.readRecords()).filter((r) => r.closeRetention !== undefined && r.closeRetention.supersededBy === undefined);
  // close-retention.sh validate_boot: `if state and not state.get('supersededBy'): require(state['generation']==g)` -> the instance can no longer boot.
  for (const record of held) expect(canonicalRetentionValue(record.closeRetention!.generation), `record ${record.operationId} (${record.closeRetention!.phase}) still holds an old generation`).toBe(canonicalRetentionValue(h.current()));
});

it("R2: a writer admitted past an intent leaves no unsuperseded record behind (restore() mounts the volume read-only for ANY unsuperseded record, so the admitted writer would meet a read-only volume after the next boot)", async () => {
  const h = await fixture(); h.storage.seal.mockRejectedValueOnce(new Error("remount busy"));
  await h.executor().answer(h.invocation);
  await h.executor().admitWriter({ ...h.invocation, kind: "task", operationId: randomUUID(), fence: 10, payload: { conversationId: randomUUID(), prompt: "continue" } });
  const held = (await h.journal.readRecords()).filter((r) => r.closeRetention !== undefined && r.closeRetention.supersededBy === undefined);
  expect(held.map((r) => r.closeRetention!.phase)).toEqual([]);
});
