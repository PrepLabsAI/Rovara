// The record of the baseline round on the document store: each state transition, each refused transition, the stored keys and attributes (against the keys Cloud
// stores), the time to live, and the guards that keep a result from a round that is not the one that was started out of the record.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt, type DocumentStore, type TransactItem } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import {
  baselineStartItem, markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaseline, readWorkflowE2EBaselineRecord, recordWorkflowE2EBaseline, requestWorkflowE2EBaselineRound,
} from "../../packages/broker/src/core/e2e/baseline.js";
import { E2E_BASELINE_ATTEMPT } from "../../packages/broker/src/core/e2e/baseline.js";

const AT = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T10:30:00.000Z";
const clock = (iso: string) => () => new Date(iso);
const hex = (char: string) => char.repeat(64);
const COMPANY = "org_00000000000000000000";

const run = async (store: DocumentStore, items: TransactItem[]) => store.transact(items);

describe("the baseline record", () => {
  const task = { taskId: "task-1", ownerKey: "developer:maya", workspaceId: "ws-1",
    workflow: { e2e: { required: true, contractDigest: hex("a"), applicationSelection: {} } } } as never;
  const started = { baseCommitSha: "b".repeat(40), operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), startedAt: AT, deadlineAt: LATER };
  const expected = { operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), baseCommitSha: "b".repeat(40), attempt: E2E_BASELINE_ATTEMPT };
  const setup = () => {
    const store = new MemoryDocumentStore();
    const deps = { store, now: clock(AT) };
    const objects = createDocumentObjectStorage(store, { companyId: COMPANY });
    return { store, deps, objects };
  };
  const verified = (overrides: Partial<{ roundId: string; admissionSha256: string }> = {}) => ({ [Symbol("verified-baseline")]: true, roundId: "round-1", admissionSha256: hex("c"),
    baseline: { status: "PASSED", scenarios: [] }, artifacts: [], ...overrides }) as never;

  it("is asked for once per approved plan, at Cloud's key, with a time to live", async () => {
    const { store, deps } = setup();
    expect(await requestWorkflowE2EBaselineRound(deps, task, { enabled: true })).toBe("REQUESTED");
    expect(await requestWorkflowE2EBaselineRound(deps, task, { enabled: true })).toBe("ALREADY");
    const row = await store.get({ pk: "DEVTASK#task-1", sk: `E2E_BASELINE#${hex("a")}` });
    expect(row).toMatchObject({ entityType: "WORKFLOW_E2E_BASELINE", schemaVersion: 2, taskId: "task-1", contractDigest: hex("a"), purpose: "baseline", attempt: 1, state: "REQUESTED", requestedAt: AT });
    expect(row?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(indexExpiresAt(AT));
  });

  it("asks for nothing when the project switched it off or the plan is not an application plan", async () => {
    const { store, deps } = setup();
    expect(await requestWorkflowE2EBaselineRound(deps, task, { enabled: false })).toBe("NOT_REQUESTED");
    expect(await requestWorkflowE2EBaselineRound(deps, { taskId: "task-2", workflow: { e2e: { required: true, contractDigest: hex("a") } } } as never, { enabled: true })).toBe("NOT_REQUESTED");
    expect(store.size).toBe(0);
  });

  it("cannot be started when it was never asked for", async () => {
    const { store } = setup();
    expect(await run(store, [baselineStartItem(task, started)])).toMatchObject({ applied: false });
    expect(store.size).toBe(0);
  });

  it("keeps the AI-navigated scenarios a round left out, only as a bounded list of ids and titles", async () => {
    const { store, deps } = setup();
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    await run(store, [baselineStartItem(task, { ...started, skippedAiScenarios: [{ scenarioId: "s1", title: "Pay" }] })]);
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.skippedAiScenarios).toEqual([{ scenarioId: "s1", title: "Pay" }]);
    expect(() => baselineStartItem(task, { ...started, skippedAiScenarios: [{ scenarioId: "", title: "x" }] })).toThrow();
  });

  it("records the verified result only for the round, operation, admission, base commit and attempt that were started", async () => {
    const { store, deps, objects } = setup();
    const both = { ...deps, objects };
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    await run(store, [baselineStartItem(task, started)]);
    for (const wrong of [{ operationId: "op-9" }, { roundId: "round-9" }, { admissionSha256: hex("d") }, { baseCommitSha: "e".repeat(40) }, { attempt: 2 }]) {
      const mismatched = "roundId" in wrong || "admissionSha256" in wrong
        ? await recordWorkflowE2EBaseline(both, task, { verified: verified(), expected: { ...expected, ...wrong } }).catch((error: unknown) => (error as Error).message)
        : await recordWorkflowE2EBaseline(both, task, { verified: verified(), expected: { ...expected, ...wrong } });
      expect(mismatched === false || typeof mismatched === "string").toBe(true);
    }
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.state).toBe("STARTED");
    expect(await recordWorkflowE2EBaseline(both, task, { verified: verified(), expected })).toBe(true);
    const record = await readWorkflowE2EBaselineRecord(deps, task);
    expect(record).toMatchObject({ state: "RECORDED", baseline: { status: "PASSED", scenarios: [] }, recordedAt: AT });
    // A recorded result is final: a second record, an unavailable mark and a late start all leave it.
    expect(await recordWorkflowE2EBaseline(both, task, { verified: verified(), expected })).toBe(false);
    expect(await markWorkflowE2EBaselineUnavailable(deps, task, "timed-out", { from: ["REQUESTED", "STARTED", "UNAVAILABLE"] })).toBe(false);
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.state).toBe("RECORDED");
  });

  it("refuses a verification that is not of the started round, or that the verifier did not make", async () => {
    const { store, deps, objects } = setup();
    const both = { ...deps, objects };
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    await run(store, [baselineStartItem(task, started)]);
    await expect(recordWorkflowE2EBaseline(both, task, { verified: verified({ roundId: "other" }), expected })).rejects.toThrow(/not of the round/);
    await expect(recordWorkflowE2EBaseline(both, task, { verified: verified({ admissionSha256: hex("f") }), expected })).rejects.toThrow(/not of the round/);
    // Rows a caller made up carry no mark of the verifier.
    await expect(recordWorkflowE2EBaseline(both, task, { verified: { roundId: "round-1", admissionSha256: hex("c"), baseline: { status: "PASSED", scenarios: [] }, artifacts: [] } as never, expected })).rejects.toThrow(/not of the round/);
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.state).toBe("STARTED");
  });

  it("never marks a plan that is not this record's, and reads nothing for a task with no approved plan", async () => {
    const { deps } = setup();
    expect(await markWorkflowE2EBaselineUnavailable(deps, { taskId: "task-3", workflow: {} } as never, "refused", { from: ["REQUESTED"] })).toBe(false);
    expect(await readWorkflowE2EBaselineRecord(deps, { taskId: "task-3", workflow: {} } as never)).toBeUndefined();
    // Nothing was written by the failed mark (an update of an absent record must not create one).
    expect(await markWorkflowE2EBaselineUnavailable(deps, task, "refused", { from: ["REQUESTED"] })).toBe(false);
    expect(await readWorkflowE2EBaselineRecord(deps, task)).toBeUndefined();
  });

  it("shows the sentence for a round that never answered, past its deadline and the grace", async () => {
    const { store, deps } = setup();
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    await run(store, [baselineStartItem(task, started)]);
    expect(await readWorkflowE2EBaseline(deps, task, Date.parse(LATER))).toBeUndefined();
    expect(await readWorkflowE2EBaseline(deps, task, Date.parse(LATER) + 6 * 60_000)).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("does not read a record that is another plan's, another task's or has a recorded result that is no result", async () => {
    const { store, deps } = setup();
    const key = { pk: "DEVTASK#task-1", sk: `E2E_BASELINE#${hex("a")}` };
    const base = { ...key, entityType: "WORKFLOW_E2E_BASELINE", taskId: "task-1", contractDigest: hex("a"), purpose: "baseline", attempt: 1, requestedAt: AT };
    await store.put({ item: { ...base, state: "RECORDED", baseline: { status: "PASSED", scenarios: "nope" } } });
    expect(await readWorkflowE2EBaselineRecord(deps, task)).toBeUndefined();
    await store.put({ item: { ...base, state: "REQUESTED", taskId: "task-9" } });
    expect(await readWorkflowE2EBaselineRecord(deps, task)).toBeUndefined();
    await store.put({ item: { ...base, state: "REQUESTED", contractDigest: hex("b") } });
    expect(await readWorkflowE2EBaselineRecord(deps, task)).toBeUndefined();
    await store.put({ item: { ...base, state: "REQUESTED" } });
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.state).toBe("REQUESTED");
  });
});
