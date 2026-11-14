import { describe, expect, it, vi } from "vitest";
import { captureEvalRoundEvidence, type WorkflowSnapshot } from "@agentx/contracts";
import { loadEvalRound, evalRoundsSoFar, evalRequestFor } from "../../packages/broker/src/core/proof/eval-round-reader.js";
import type { TestProofActions } from "../../packages/broker/src/developer/test-proof-lines.js";
const digest = "a".repeat(64);
const task = { ownerKey: "owner-a", workspaceId: "workspace-a" };
const operation = (n: number) => ({ id: `op-${n}`, kind: "task", status: "SUCCEEDED", createdAt: `2026-11-14T00:00:${String(n).padStart(2, "0")}.000Z`, fence: n });
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
  it("returns the newest matching artifact and reads the supplied operations only once", async () => {
    const w = world({ [key(1)]: JSON.stringify(artifact()), [key(2)]: JSON.stringify({ ...artifact(), usage: { calls: 8, costMicros: 80 } }) });
    expect(await loadEvalRound(w.actions, task, digest, [operation(1), operation(2)])).toMatchObject({ usage: { calls: 8 } }); expect(w.operations()).toBe(0);
  });
  it("skips a different digest but never binds its result to this candidate", async () => { const w = world({ [key(1)]: JSON.stringify(artifact("b".repeat(64))) }); expect(await loadEvalRound(w.actions, task, digest)).toBeUndefined(); });
  it.each(["private/owner-b/workspace-a/op-1/eval-round.json", "private/owner-a/workspace-b/op-1/eval-round.json", "private/owner-a/workspace-a/op-2/eval-round.json"]) ("refuses another scope's key %s before reading bytes", async objectKey => { const w = world(); w.actions.artifacts = async () => [{ name: "eval-round.json", objectKey }]; expect(await loadEvalRound(w.actions, task, digest)).toBeUndefined(); expect(w.read).toEqual([]); });
  it.each(["{broken-secret", "x".repeat(1_048_577), JSON.stringify({ ...artifact(), outcome: "unknown-secret" })])("rejects unreadable evidence without falling back to older partial data", async newer => { const w = world({ [key(2)]: newer, [key(1)]: JSON.stringify(artifact()) }, [operation(1), operation(2)]); expect(await loadEvalRound(w.actions, task, digest)).toBeUndefined(); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); });
  it("has one total read-byte allowance and ten-operation limit", async () => {
    const ops = Array.from({ length: 10 }, (_, i) => operation(i)); const files = Object.fromEntries(ops.map(op => [key(op.fence), JSON.stringify({ ...artifact(), ignoredFuture: "x".repeat(120_000) })]));
    const w = world(files, ops); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined();
    expect(w.listings()).toBeLessThanOrEqual(10); expect(w.read).toHaveLength(9);
    expect(w.read[0]?.cap).toBe(1_048_576); expect(w.read.at(-1)!.cap).toBeLessThan(120_000);
  });
  it("counts done rounds across digests and carries spent refusal usage too", async () => {
    const declined = { ...artifact(), outcome: "not_run", notRunReason: "provider_error", questions: undefined, options: undefined, usage: { calls: 2, costMicros: 20 } };
    const w = world({ [key(1)]: JSON.stringify(artifact()), [key(2)]: JSON.stringify(artifact("b".repeat(64))), [key(3)]: JSON.stringify(declined) }, [operation(1), operation(2), operation(3)]);
    expect(await evalRoundsSoFar(w.actions, task)).toEqual({ done: 2, calls: 10, costMicros: 100 }); expect(w.operations()).toBe(1);
  });
  it("does not guess unknown cost as zero", async () => { const w = world({ [key(1)]: JSON.stringify({ ...artifact(), usage: { calls: 4 } }) }); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); });
  it("does not authorize another pass from a truncated operation history", async () => { const w = world({}, Array.from({ length: 11 }, (_, i) => operation(i))); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); });
  it("does not authorize a third pass from an orphaned completed pass two", async () => { const a = artifact(); const w = world({ [key(1)]: JSON.stringify({ ...a, evalPass: 2, context: { ...a.context, previousPasses: 1 } }) }); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); });
  it("returns exact totals for a complete first and second pass", async () => {
    const a = artifact(); const second = { ...a, evalPass: 2, context: { ...a.context, previousPasses: 1 } };
    const w = world({ [key(1)]: JSON.stringify(a), [key(2)]: JSON.stringify(second) }, [operation(1), operation(2)]);
    expect(await evalRoundsSoFar(w.actions, task)).toEqual({ done: 2, calls: 8, costMicros: 80 });
  });
  it("bounds a stalled read with the existing proof timeout and stops further reads", async () => {
    vi.useFakeTimers();
    try {
      const w = world(); let release!: (s: string) => void; w.actions.readArtifact = () => new Promise(resolve => { release = resolve; });
      const result = loadEvalRound(w.actions, task, digest); await vi.advanceTimersByTimeAsync(1600); expect(await result).toBeUndefined(); release(JSON.stringify(artifact())); await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
  it("refuses oversized operation/listing inputs in bounded time", async () => {
    const w = world(); w.actions.operations = async () => Array.from({ length: 100_001 }, () => operation(1));
    const before = performance.now(); expect(await evalRoundsSoFar(w.actions, task)).toBeUndefined(); expect(performance.now() - before).toBeLessThan(1000); expect(w.listings()).toBe(0);
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
