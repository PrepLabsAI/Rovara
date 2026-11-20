import { describe, expect, it, vi } from "vitest";
import { captureEvalRoundEvidence, evalResultFromArtifact, type WorkflowSnapshot } from "@agentx/contracts";
import { expectLinearScalingAsync } from "../support/scaling.js";
import { loadEvalRound, evalRoundsSoFar, evalRequestFor } from "../../packages/broker/src/core/proof/eval-round-reader.js";
import type { TestProofActions } from "../../packages/broker/src/developer/test-proof-lines.js";
const digest = "a".repeat(64);
const task = { ownerKey: "owner-a", workspaceId: "workspace-a" };
const operation = (n: number) => ({ id: `op-${n}`, kind: "task", status: "SUCCEEDED", createdAt: new Date(Date.UTC(2026, 10, 14, 0, 0, n)).toISOString(), fence: n });
const key = (n: number) => `private/owner-a/workspace-a/op-${n}/eval-round.json`;
function artifact(candidateDigest = digest) {
  return { schemaVersion: 1, candidateDigest, roundKind: "check_unsealed", evalPass: 1, outcome: "done", usage: { calls: 4, costMicros: 40 }, cache: "hit", evalConfigured: true,
    ...captureEvalRoundEvidence({ context: { aiChange: true, discovery: "configured", previousPasses: 0 }, comparison: { questions: [{ id: "q", category: "ordinary", old: Array.from({ length: 3 }, () => ({ pass: true, answer: "yes" })), first: { pass: true, answer: "yes" } }], changedPromptCalls: 1, subsetSupported: true } }) };
}
function world(files: Record<string, string> = { [key(1)]: JSON.stringify(artifact()) }, ops = [operation(1)]) {
  const read: Array<{ key: string; cap: number }> = []; let operations = 0; let listings = 0;
  const actions: TestProofActions = { operations: async () => { operations++; return ops; }, artifacts: async (_workspace, id) => { listings++; return files[`private/owner-a/workspace-a/${id}/eval-round.json`] === undefined ? [] : [{ name: "eval-round.json", objectKey: `private/owner-a/workspace-a/${id}/eval-round.json` }]; }, readArtifact: async (key, cap) => { read.push({ key, cap }); return files[key]!; } };
  return { actions, read, operations: () => operations, listings: () => listings };
}
describe("bound eval-round reader", () => {
  it.each(["private/owner-b/workspace-a/op-1/eval-round.json", "private/owner-a/workspace-b/op-1/eval-round.json", "private/owner-a/workspace-a/op-2/eval-round.json"]) ("refuses another scope's key %s before reading bytes", async objectKey => { const w = world(); w.actions.artifacts = async () => [{ name: "eval-round.json", objectKey }]; expect(await loadEvalRound(w.actions, task, digest)).toMatchObject({ outcome: "not_run", notRunReason: "invalid_question_data" }); expect(w.read).toEqual([]); });
  it.each(["{broken-secret", "x".repeat(1_048_577), JSON.stringify({ ...artifact(), outcome: "unknown-secret" })])("rejects unreadable evidence without falling back to older partial data", async newer => { const w = world({ [key(2)]: newer, [key(1)]: JSON.stringify(artifact()) }, [operation(1), operation(2)]); expect(await loadEvalRound(w.actions, task, digest)).toMatchObject({ outcome: "not_run", notRunReason: "invalid_question_data" }); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); });
  it("does not guess unknown cost as zero", async () => { const w = world({ [key(1)]: JSON.stringify({ ...artifact(), usage: { calls: 4 } }) }); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); });
  it("finds and counts an eval older than the newest ten operations", async () => {
    const w = world({ [key(1)]: JSON.stringify(artifact()) }, Array.from({ length: 12 }, (_, i) => operation(i + 1)));
    expect(await loadEvalRound(w.actions, task, digest)).toMatchObject({ outcome: "done", usage: { calls: 4 } });
    expect(await evalRoundsSoFar(w.actions, task)).toEqual({ done: 1, calls: 4, costMicros: 40 });
  });
  it.each([undefined, "{private-missing-evidence", JSON.stringify(artifact("b".repeat(64)))])("returns a fixed Not run result for missing or unreadable evidence", async text => {
    const w = world(text === undefined ? {} : { [key(1)]: text });
    const loaded = await loadEvalRound(w.actions, task, digest);
    expect(loaded).toMatchObject({ outcome: "not_run", candidateDigest: digest, notRunReason: "invalid_question_data" });
    expect(evalResultFromArtifact(loaded)).toMatchObject({ label: "Not run", notRun: { reason: "invalid_question_data" } });
    expect(JSON.stringify(loaded)).not.toContain("private-missing-evidence");
    expect(loaded?.usage?.costMicros).toBeUndefined();
  });
  it("does not authorize a third pass from an orphaned completed pass two", async () => { const a = artifact(); const w = world({ [key(1)]: JSON.stringify({ ...a, evalPass: 2, context: { ...a.context, previousPasses: 1 } }) }); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); });
  it("bounds a stalled read with the existing proof timeout and stops further reads", async () => {
    vi.useFakeTimers();
    try {
      const w = world(); let release!: (s: string) => void; w.actions.readArtifact = () => new Promise(resolve => { release = resolve; });
      const result = loadEvalRound(w.actions, task, digest); await vi.advanceTimersByTimeAsync(1600); expect(await result).toMatchObject({ outcome: "not_run", notRunReason: "invalid_question_data" }); release(JSON.stringify(artifact())); await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
  it("refuses oversized operation/listing inputs in bounded time", async () => {
    // Refused on the length alone: the cost does not grow with the list (12,501, then 100,008 operations).
    const worlds = new Map<number, ReturnType<typeof world>>();
    const results = new Map<number, unknown>();
    await expectLinearScalingAsync((count) => {
      const w = world(); const operations = Array.from({ length: count }, () => operation(1));
      w.actions.operations = async () => operations; worlds.set(count, w);
      return async () => { results.set(count, await evalRoundsSoFar(w.actions, task)); };
    }, { n: 12_501, unitBytes: 0, label: "eval rounds: oversized operation list" }); // N cannot shrink below the 10,000 bound; the refusal reads only the array length and touches no element, so no input that grows with n is read (unitBytes 0)
    expect([results.get(12_501), results.get(100_008)]).toEqual([undefined, undefined]);
    expect([worlds.get(12_501)!.listings(), worlds.get(100_008)!.listings()]).toEqual([0, 0]);
  });
  it("bounds metadata strings before parsing dates", async () => {
    const w = world({}, [{ ...operation(1), createdAt: "Nov 14 2026" + " ".repeat(100_000) }]);
    expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); expect(w.listings()).toBe(0);
  });
});
describe("broker eval requests", () => {
  const workflow = (reason = "eval_hint") => ({ flow: { tier: { reasons: [{ code: reason }] } } }) as unknown as WorkflowSnapshot;
  it("uses only eval_hint and never requests a third pass", () => {
    expect(evalRequestFor(workflow("other"), { done: 0, calls: 0, costMicros: 0 })).toBeUndefined();
    expect(evalRequestFor(workflow(), { done: 0, calls: 0, costMicros: 0 })).toEqual({ aiChange: true, reason: "eval_hint", evalPass: 1, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 });
    expect(evalRequestFor(workflow(), { done: 1, calls: 27, costMicros: 270 })).toMatchObject({ evalPass: 2, callsAlreadyUsed: 27, costAlreadyUsedMicros: 270 });
    expect(evalRequestFor(workflow(), { done: 2, calls: 28, costMicros: 280 })).toBeUndefined();
  });
  it.each([undefined, null, {}, { done: -1, calls: 0, costMicros: 0 }, { done: 1, calls: NaN, costMicros: 0 }, { done: 0, calls: 0, costMicros: -1 }])("refuses missing or invalid prior usage %j", usage => { expect(evalRequestFor(workflow(), usage as never)).toBeUndefined(); });
});
