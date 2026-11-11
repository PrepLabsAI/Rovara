// The records of the baseline, replay and grounding rounds on the document store: each state transition, each refused transition, the stored keys and attributes (against the keys Cloud
// stores), the time to live, and the guards that keep a result from a round that is not the one that was started out of the record.
import { describe, expect, it } from "vitest";
import { INDEX_EXPIRY_ATTRIBUTE, indexExpiresAt, type DocumentStore, type TransactItem } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import {
  baselineStartItem, markWorkflowE2EBaselineUnavailable, readWorkflowE2EBaseline, readWorkflowE2EBaselineRecord, recordWorkflowE2EBaseline, requestWorkflowE2EBaselineRound,
} from "../../packages/broker/src/core/e2e/baseline.js";
import {
  listWorkflowE2EReplayRecords, markWorkflowE2EReplayUnavailable, readWorkflowE2EReplayRecord, recordWorkflowE2EReplay, replayStartItem, requestWorkflowE2EReplay,
} from "../../packages/broker/src/core/e2e/replay.js";
import {
  groundingStartItem, markWorkflowE2EGroundingUnavailable, readWorkflowE2EGroundingRecord, recordWorkflowE2EGrounding, requestWorkflowE2EGroundingRound,
} from "../../packages/broker/src/core/e2e/grounding.js";
import { E2E_BASELINE_ATTEMPT } from "../../packages/broker/src/aws/workflow-e2e-baseline.js";

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

  it("starts exactly once, as an item of the accepting transaction", async () => {
    const { store, deps } = setup();
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    expect(await run(store, [baselineStartItem(task, started)])).toEqual({ applied: true });
    expect(await readWorkflowE2EBaselineRecord(deps, task)).toMatchObject({ state: "STARTED", operationId: "op-1", roundId: "round-1", baseCommitSha: "b".repeat(40), deadlineAt: LATER });
    // A second start finds it no longer REQUESTED, so its transaction fails whole.
    expect(await run(store, [baselineStartItem(task, { ...started, operationId: "op-2" })])).toMatchObject({ applied: false, reason: "condition_failed" });
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.operationId).toBe("op-1");
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

  it("does not record a round that is not the one the record started, even when its verification is of that round", async () => {
    const { store, deps, objects } = setup();
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    await run(store, [baselineStartItem(task, started)]);
    expect(await recordWorkflowE2EBaseline({ ...deps, objects }, task, { verified: verified({ roundId: "round-2" }), expected: { ...expected, roundId: "round-2" } })).toBe(false);
    expect(await recordWorkflowE2EBaseline({ ...deps, objects }, task, { verified: verified({ admissionSha256: hex("e") }), expected: { ...expected, admissionSha256: hex("e") } })).toBe(false);
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.state).toBe("STARTED");
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

  it("marks a round unavailable only from a state named, and only for the operation named", async () => {
    const { store, deps } = setup();
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    await run(store, [baselineStartItem(task, started)]);
    expect(await markWorkflowE2EBaselineUnavailable(deps, task, "run-failed", { from: ["REQUESTED"] })).toBe(false);
    expect(await markWorkflowE2EBaselineUnavailable(deps, task, "run-failed", { from: ["STARTED"], operationId: "op-other" })).toBe(false);
    expect((await readWorkflowE2EBaselineRecord(deps, task))?.state).toBe("STARTED");
    expect(await markWorkflowE2EBaselineUnavailable(deps, task, "run-failed", { from: ["STARTED"], operationId: "op-1" })).toBe(true);
    expect(await readWorkflowE2EBaselineRecord(deps, task)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed", recordedAt: AT });
    expect(await markWorkflowE2EBaselineUnavailable({ ...deps, now: clock(LATER) }, task, "timed-out", { from: ["UNAVAILABLE"] })).toBe(true);
    expect((await store.get({ pk: "DEVTASK#task-1", sk: `E2E_BASELINE#${hex("a")}` }))?.[INDEX_EXPIRY_ATTRIBUTE]).toBe(indexExpiresAt(LATER));
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

describe("the replay record", () => {
  const task = { taskId: "task-1" };
  const round = { sourceRoundId: "src-1", attempt: 1 };
  const started = { ...round, operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), startedAt: AT, deadlineAt: LATER };
  const expected = { ...round, operationId: "op-1", roundId: "round-1", admissionSha256: hex("c") };
  const verified = (overrides: Record<string, unknown> = {}) => ({ [Symbol("verified-replay")]: true, roundId: "round-1", admissionSha256: hex("c"),
    replay: { status: "PASS", reproduced: true, downloadSha256Match: true }, ...overrides }) as never;
  const setup = () => { const store = new MemoryDocumentStore(); return { store, deps: { store, now: clock(AT) } }; };

  it("is asked for once per source round and attempt, at Cloud's key", async () => {
    const { store, deps } = setup();
    expect(await requestWorkflowE2EReplay(deps, task, { ...round, requestedBy: "developer:ops" })).toBe("REQUESTED");
    expect(await requestWorkflowE2EReplay(deps, task, round)).toBe("ALREADY");
    expect(await store.get({ pk: "DEVTASK#task-1", sk: "E2E_REPLAY#src-1#1" })).toMatchObject({ entityType: "WORKFLOW_E2E_REPLAY", schemaVersion: 1, purpose: "replay", state: "REQUESTED",
      requestedBy: "developer:ops", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(AT) });
  });

  it("starts once, records only for the round that was started, and keeps a recorded result", async () => {
    const { store, deps } = setup();
    await requestWorkflowE2EReplay(deps, task, round);
    expect(await run(store, [replayStartItem(task, started)])).toEqual({ applied: true });
    expect(await run(store, [replayStartItem(task, { ...started, operationId: "op-2" })])).toMatchObject({ applied: false });
    for (const wrong of [{ operationId: "op-9" }, { roundId: "round-9" }, { admissionSha256: hex("d") }, { attempt: 2 }, { sourceRoundId: "src-2" }]) {
      if ("roundId" in wrong || "admissionSha256" in wrong) await expect(recordWorkflowE2EReplay(deps, task, { verified: verified(), expected: { ...expected, ...wrong } })).rejects.toThrow();
      else expect(await recordWorkflowE2EReplay(deps, task, { verified: verified(), expected: { ...expected, ...wrong } })).toBe(false);
    }
    await expect(recordWorkflowE2EReplay(deps, task, { verified: { roundId: "round-1", admissionSha256: hex("c"), replay: {} } as never, expected })).rejects.toThrow();
    // A verification of some other round, matching what the caller expects, still does not match what the record started.
    expect(await recordWorkflowE2EReplay(deps, task, { verified: verified({ roundId: "round-2" }), expected: { ...expected, roundId: "round-2" } })).toBe(false);
    expect(await recordWorkflowE2EReplay(deps, task, { verified: verified({ admissionSha256: hex("e") }), expected: { ...expected, admissionSha256: hex("e") } })).toBe(false);
    expect((await readWorkflowE2EReplayRecord(deps, "task-1", round))?.state).toBe("STARTED");
    expect(await recordWorkflowE2EReplay(deps, task, { verified: verified(), expected })).toBe(true);
    expect(await readWorkflowE2EReplayRecord(deps, "task-1", round)).toMatchObject({ state: "RECORDED", replay: { status: "PASS", reproduced: true } });
    expect(await recordWorkflowE2EReplay(deps, task, { verified: verified(), expected })).toBe(false);
    expect(await markWorkflowE2EReplayUnavailable(deps, task, round, "stopped", { from: ["REQUESTED", "STARTED", "UNAVAILABLE"] })).toBe(false);
  });

  it("marks unavailable only from a state named and for the operation named, and never creates a record", async () => {
    const { store, deps } = setup();
    expect(await markWorkflowE2EReplayUnavailable(deps, task, round, "stopped", { from: ["REQUESTED"] })).toBe(false);
    expect(store.size).toBe(0);
    await requestWorkflowE2EReplay(deps, task, round);
    await run(store, [replayStartItem(task, started)]);
    expect(await markWorkflowE2EReplayUnavailable(deps, task, round, "timed-out", { from: ["STARTED"], operationId: "op-9" })).toBe(false);
    expect(await markWorkflowE2EReplayUnavailable(deps, task, round, "timed-out", { from: ["REQUESTED"] })).toBe(false);
    expect(await markWorkflowE2EReplayUnavailable(deps, task, round, "timed-out", { from: ["STARTED"], operationId: "op-1" })).toBe(true);
    expect(await readWorkflowE2EReplayRecord(deps, "task-1", round)).toMatchObject({ state: "UNAVAILABLE", reason: "timed-out" });
  });

  it("lists the attempts of one source round, oldest first, and no other round's", async () => {
    const { deps } = setup();
    for (const attempt of [3, 1, 2]) await requestWorkflowE2EReplay(deps, task, { sourceRoundId: "src-1", attempt });
    await requestWorkflowE2EReplay(deps, task, { sourceRoundId: "src-10", attempt: 1 });
    await requestWorkflowE2EReplay(deps, { taskId: "task-2" }, { sourceRoundId: "src-1", attempt: 1 });
    expect((await listWorkflowE2EReplayRecords(deps, "task-1", "src-1")).map((record) => record.attempt)).toEqual([1, 2, 3]);
  });

  it("reads no record whose result is not a result of the contract", async () => {
    const { store, deps } = setup();
    await store.put({ item: { pk: "DEVTASK#task-1", sk: "E2E_REPLAY#src-1#1", entityType: "WORKFLOW_E2E_REPLAY", taskId: "task-1", sourceRoundId: "src-1", purpose: "replay", attempt: 1, state: "RECORDED", requestedAt: AT, replay: { status: "?" } } });
    expect(await readWorkflowE2EReplayRecord(deps, "task-1", round)).toBeUndefined();
    expect(await readWorkflowE2EReplayRecord(deps, "task-2", round)).toBeUndefined();
  });
});

describe("the grounding record", () => {
  const task = { ownerKey: "developer:maya", workspaceId: "ws-1" };
  const ref = { taskId: "task-1", planArtifactSha256: hex("a"), attempt: 1 };
  const started = { baseCommitSha: "b".repeat(40), operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), selectionDigest: hex("d"), startedAt: AT, deadlineAt: LATER };
  const expected = { operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), baseCommitSha: "b".repeat(40) };
  const verified = (overrides: Record<string, unknown> = {}) => ({ [Symbol("verified-grounding")]: true, roundId: "round-1", admissionSha256: hex("c"),
    results: { status: "PASSED", scenarios: [] }, findings: [], artifacts: [], ...overrides }) as never;
  const setup = () => {
    const store = new MemoryDocumentStore();
    return { store, deps: { store, now: clock(AT), objects: createDocumentObjectStorage(store, { companyId: COMPANY }) } };
  };

  it("is asked for once per plan artifact and attempt, at Cloud's key, and refuses scenario ids that are not a bounded list", async () => {
    const { store, deps } = setup();
    expect(await requestWorkflowE2EGroundingRound(deps, ref, { scenarioIds: ["s1", "s2"], planArtifactId: "art-1" })).toBe("REQUESTED");
    expect(await requestWorkflowE2EGroundingRound(deps, ref, { scenarioIds: ["s1"], planArtifactId: "art-1" })).toBe("ALREADY");
    expect(await store.get({ pk: "DEVTASK#task-1", sk: `E2E_GROUNDING#${hex("a")}#1` })).toMatchObject({ entityType: "WORKFLOW_E2E_GROUNDING", purpose: "grounding", state: "REQUESTED",
      scenarioIds: ["s1", "s2"], planArtifactId: "art-1", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(AT) });
    await expect(requestWorkflowE2EGroundingRound(deps, { ...ref, attempt: 2 }, { scenarioIds: [], planArtifactId: "art-1" })).rejects.toThrow();
  });

  it("starts once, records only for the started round, and keeps a recorded result", async () => {
    const { store, deps } = setup();
    await requestWorkflowE2EGroundingRound(deps, ref, { scenarioIds: ["s1"], planArtifactId: "art-1" });
    expect(await run(store, [groundingStartItem(ref, started)])).toEqual({ applied: true });
    expect(await run(store, [groundingStartItem(ref, { ...started, operationId: "op-2" })])).toMatchObject({ applied: false });
    for (const wrong of [{ operationId: "op-9" }, { baseCommitSha: "e".repeat(40) }]) {
      expect(await recordWorkflowE2EGrounding(deps, task, ref, { verified: verified(), expected: { ...expected, ...wrong } })).toBe(false);
    }
    await expect(recordWorkflowE2EGrounding(deps, task, ref, { verified: verified({ roundId: "x" }), expected })).rejects.toThrow();
    expect(await recordWorkflowE2EGrounding(deps, task, ref, { verified: verified({ roundId: "round-2" }), expected: { ...expected, roundId: "round-2" } })).toBe(false);
    expect(await recordWorkflowE2EGrounding(deps, task, ref, { verified: verified({ admissionSha256: hex("e") }), expected: { ...expected, admissionSha256: hex("e") } })).toBe(false);
    await expect(recordWorkflowE2EGrounding(deps, task, ref, { verified: { roundId: "round-1", admissionSha256: hex("c"), results: {}, findings: [], artifacts: [] } as never, expected })).rejects.toThrow();
    expect(await recordWorkflowE2EGrounding(deps, task, { ...ref, attempt: 2 }, { verified: verified(), expected })).toBe(false);
    expect((await readWorkflowE2EGroundingRecord(deps, ref))?.state).toBe("STARTED");
    expect(await recordWorkflowE2EGrounding(deps, task, ref, { verified: verified(), expected })).toBe(true);
    expect(await readWorkflowE2EGroundingRecord(deps, ref)).toMatchObject({ state: "RECORDED", results: { status: "PASSED" }, findings: [], selectionDigest: hex("d") });
    expect(await recordWorkflowE2EGrounding(deps, task, ref, { verified: verified(), expected })).toBe(false);
    expect(await markWorkflowE2EGroundingUnavailable(deps, ref, "timed-out", { from: ["REQUESTED", "STARTED", "UNAVAILABLE"] })).toBe(false);
  });

  it("marks unavailable only with a fixed reason, from a state named, for the operation named", async () => {
    const { store, deps } = setup();
    await requestWorkflowE2EGroundingRound(deps, ref, { scenarioIds: ["s1"], planArtifactId: "art-1" });
    await expect(markWorkflowE2EGroundingUnavailable(deps, ref, "a free sentence" as never, { from: ["REQUESTED"] })).rejects.toThrow(/fixed reason/);
    await run(store, [groundingStartItem(ref, started)]);
    expect(await markWorkflowE2EGroundingUnavailable(deps, ref, "run-failed", { from: ["REQUESTED"] })).toBe(false);
    expect(await markWorkflowE2EGroundingUnavailable(deps, ref, "run-failed", { from: ["STARTED"], operationId: "op-9" })).toBe(false);
    expect(await markWorkflowE2EGroundingUnavailable(deps, { ...ref, attempt: 2 }, "run-failed", { from: ["STARTED"] })).toBe(false);
    expect(await markWorkflowE2EGroundingUnavailable(deps, ref, "run-failed", { from: ["STARTED"], operationId: "op-1" })).toBe(true);
    expect(await readWorkflowE2EGroundingRecord(deps, ref)).toMatchObject({ state: "UNAVAILABLE", reason: "run-failed" });
  });

  it("reads a recorded result only whole, and a reason only when it is one of the fixed ones", async () => {
    const { store, deps } = setup();
    const base = { pk: "DEVTASK#task-1", sk: `E2E_GROUNDING#${hex("a")}#1`, entityType: "WORKFLOW_E2E_GROUNDING", taskId: "task-1", planArtifactSha256: hex("a"), purpose: "grounding", attempt: 1,
      requestedAt: AT, scenarioIds: ["s1"], planArtifactId: "art-1" };
    await store.put({ item: { ...base, state: "RECORDED", results: { status: "PASSED", scenarios: [] } } });
    expect(await readWorkflowE2EGroundingRecord(deps, ref)).toBeUndefined();
    await store.put({ item: { ...base, state: "UNAVAILABLE", reason: "something else" } });
    expect(await readWorkflowE2EGroundingRecord(deps, ref)).toEqual(expect.objectContaining({ state: "UNAVAILABLE" }));
    expect((await readWorkflowE2EGroundingRecord(deps, ref))).not.toHaveProperty("reason");
    await store.put({ item: { ...base, state: "REQUESTED", scenarioIds: [] } });
    expect(await readWorkflowE2EGroundingRecord(deps, ref)).toBeUndefined();
  });
});

// The records must stay byte-identical to what the DynamoDB versions write, so Cloud can read what Code wrote and the other way round: the same legacy functions are driven with a client
// that only records the request, and the document the new version stores is compared with it.
describe("the stored records equal what the DynamoDB versions write", () => {
  type Sent = { Item: Record<string, unknown> & { pk: string; sk: string } };
  const capture = () => {
    const sent: Sent[] = [];
    return { sent, store: { tableName: "t", documentClient: { send: async (command: { input: Sent }) => { sent.push(command.input); return {}; } } } as never };
  };
  const bare = (item: Record<string, unknown>) => { const { requestedAt: _a, [INDEX_EXPIRY_ATTRIBUTE]: _b, ...rest } = item; void _a; void _b; return rest; };

  it("for a baseline, a replay and a grounding request and start", async () => {
    const legacy = await import("../../packages/broker/src/aws/workflow-e2e-baseline.js");
    const legacyReplay = await import("../../packages/broker/src/aws/workflow-e2e-replay.js");
    const legacyGrounding = await import("../../packages/broker/src/aws/workflow-e2e-grounding.js");
    const task = { taskId: "task-1", workflow: { e2e: { required: true, contractDigest: hex("a"), applicationSelection: {} } } } as never;
    const store = new MemoryDocumentStore();
    const deps = { store, now: clock(AT) };

    const old = capture();
    await legacy.requestWorkflowE2EBaselineRound(old.store, task, { enabled: true });
    await requestWorkflowE2EBaselineRound(deps, task, { enabled: true });
    const written = await store.get({ pk: old.sent[0]!.Item.pk, sk: old.sent[0]!.Item.sk });
    expect(bare(written!)).toEqual(bare(old.sent[0]!.Item));

    const baselineStart = { baseCommitSha: "b".repeat(40), operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), startedAt: AT, deadlineAt: LATER };
    const oldStart = legacy.baselineStartItem({ tableName: "t" }, task, baselineStart).Update;
    const newStart = baselineStartItem(task, baselineStart);
    expect(newStart).toMatchObject({ kind: "update", key: oldStart.Key });
    const setBy = (item: TransactItem): Record<string, unknown> => Object.fromEntries((item as unknown as { ops: Array<{ path: string[]; value: unknown }> }).ops.map((op): [string, unknown] => [op.path[0]!, op.value]));
    const values = oldStart.ExpressionAttributeValues;
    expect(setBy(newStart)).toEqual({ state: values[":started"], baseCommitSha: values[":base"], operationId: values[":operation"], roundId: values[":round"], admissionSha256: values[":admission"],
      startedAt: values[":startedAt"], deadlineAt: values[":deadline"], [INDEX_EXPIRY_ATTRIBUTE]: values[":expires"] });

    const oldReplay = capture();
    await legacyReplay.requestWorkflowE2EReplay(oldReplay.store, { taskId: "task-1" }, { sourceRoundId: "src-1", attempt: 1, requestedBy: "developer:ops" });
    await requestWorkflowE2EReplay(deps, { taskId: "task-1" }, { sourceRoundId: "src-1", attempt: 1, requestedBy: "developer:ops" });
    expect(bare((await store.get({ pk: oldReplay.sent[0]!.Item.pk, sk: oldReplay.sent[0]!.Item.sk }))!)).toEqual(bare(oldReplay.sent[0]!.Item));
    const replayStart = { sourceRoundId: "src-1", attempt: 1, operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), startedAt: AT, deadlineAt: LATER };
    expect(replayStartItem({ taskId: "task-1" }, replayStart)).toMatchObject({ key: legacyReplay.replayStartItem({ tableName: "t" }, { taskId: "task-1" }, replayStart).Update.Key });

    const ref = { taskId: "task-1", planArtifactSha256: hex("a"), attempt: 1 };
    const oldGrounding = capture();
    await legacyGrounding.requestWorkflowE2EGroundingRound(oldGrounding.store, ref, { scenarioIds: ["s1"], planArtifactId: "art-1" });
    await requestWorkflowE2EGroundingRound(deps, ref, { scenarioIds: ["s1"], planArtifactId: "art-1" });
    expect(bare((await store.get({ pk: oldGrounding.sent[0]!.Item.pk, sk: oldGrounding.sent[0]!.Item.sk }))!)).toEqual(bare(oldGrounding.sent[0]!.Item));
    const groundingStart = { baseCommitSha: "b".repeat(40), operationId: "op-1", roundId: "round-1", admissionSha256: hex("c"), selectionDigest: hex("d"), startedAt: AT, deadlineAt: LATER };
    expect(groundingStartItem(ref, groundingStart)).toMatchObject({ key: legacyGrounding.groundingStartItem({ tableName: "t" }, ref, groundingStart).Update.Key });
  });
});
