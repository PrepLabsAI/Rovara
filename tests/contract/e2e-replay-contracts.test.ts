import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2EApplicationExecutionAdmissionSchema, E2EApplicationReplaySchema, E2EExecutorPlanSchema, E2EReplayResultSchema, E2EWorkflowAdmissionRefSchema, E2E_REPLAY_CHECKS_FEATURE,
  WORKER_INVOCATION_FEATURES, E2E_REPLAY_ATTEMPTS_MAX, E2E_REPLAY_RECORDS_MAX, canonicalJson, e2eExecutorAdmissionDigest, type E2EApplicationExecutionAdmission } from "@agentx/contracts";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";

// M1.4 Task 4.6b (audit replay): the shapes a replay round is signed with. A replay is an application round of a kind of its own: its reference, its admission and its executor plan say so,
// the admission names no model route, and the digest of the admission binds the recordings it serves. Everything stored before this task (a candidate or baseline reference, an admission
// with no `replay`, a plan with none) parses exactly as it did.

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const TASK = randomUUID();
const refBase = () => ({ schemaVersion: 1 as const, kind: "application" as const, taskId: TASK, workflowRevision: 7, candidateDigest: "d".repeat(64), roundId: randomUUID(), groupRunIds: [randomUUID()],
  admissionRef: { key: `workflow-e2e-admissions/sha256/${"a".repeat(64)}.json`, sha256: "a".repeat(64), byteLength: 1000 } });

describe("the operation's reference for a replay", () => {
  it("parses a replay reference (purpose, the source round, the attempt), and still parses a candidate's and a baseline's exactly as before", () => {
    const replay = { ...refBase(), purpose: "replay" as const, sourceRoundId: randomUUID(), attempt: 1 };
    expect(E2EWorkflowAdmissionRefSchema.parse(replay)).toMatchObject({ purpose: "replay", attempt: 1 });
    expect(E2EWorkflowAdmissionRefSchema.parse(refBase()).purpose).toBeUndefined();
    expect(E2EWorkflowAdmissionRefSchema.parse({ ...refBase(), purpose: "baseline", baseCommitSha: "b".repeat(40), attempt: 1 }).purpose).toBe("baseline");
  });
  it("refuses a replay reference with no source round or no attempt, a source round or base commit on the wrong purpose, and a replay that is not an application round", () => {
    const replay = { ...refBase(), purpose: "replay" as const, sourceRoundId: randomUUID(), attempt: 1 };
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...replay, sourceRoundId: undefined }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...replay, attempt: undefined }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...replay, baseCommitSha: "b".repeat(40) }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...refBase(), sourceRoundId: randomUUID() }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...refBase(), purpose: "baseline", baseCommitSha: "b".repeat(40), attempt: 1, sourceRoundId: randomUUID() }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...replay, kind: undefined }).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...replay, purpose: "audit" }).success).toBe(false);
  });
  it("lists the replay feature among the invocation features a worker may advertise", () => {
    expect(E2E_REPLAY_CHECKS_FEATURE).toBe("task.workflowE2EReplayChecks.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(E2E_REPLAY_CHECKS_FEATURE);
  });
});

const fixture = createOrdersExecutorPlan({ probe: "api-state-positive-v1" });
const base = fixture.plan.admission;
const file = (keyHash: string) => Buffer.from(JSON.stringify({ schemaVersion: "rovara-agent-trace-file/v1", keyHash, trace: { actions: [], summary: "The recorded AI navigation concluded.", executor: { name: "rovara-e2e-agent" } } })).toString("base64");
const trace = (caseId: string, stepIndex: number) => ({ caseId, stepIndex, keyHash: sha(`key-${caseId}-${stepIndex}`), traceBase64: file(sha(`key-${caseId}-${stepIndex}`)),
  binding: { schemaVersion: "rovara-agent-trace/v1" as const, runId: randomUUID(), caseId, stepIndex, traceSha256: sha("trace"), ledgerSha256: sha("ledger"), actionCount: 1 } });
const replayOf = (overrides: Record<string, unknown> = {}) => ({ purpose: "replay" as const, sourceRoundId: randomUUID(), sourceAdmissionSha256: sha("admission"), sourceEvidenceSha256: sha("evidence"), attempt: 1,
  sourceCases: [{ caseId: "case-a", assertionOutcomes: ["passed" as const], csvSha256: sha("csv") }], traces: [trace("case-a", 1)], ...overrides });
const signed = (admission: Record<string, unknown>): E2EApplicationExecutionAdmission => {
  const body = { ...admission };
  delete body["admissionDigest"];
  return { ...body, admissionDigest: createHash("sha256").update(canonicalJson(body)).digest("hex") } as unknown as E2EApplicationExecutionAdmission;
};
const replayAdmission = (replay: unknown = replayOf(), extra: Record<string, unknown> = {}) => signed({ ...base, modelRoute: null, replay, ...extra });

describe("the admission of a replay", () => {
  it("is an admission with `replay` and no model route, and an admission with no `replay` is read exactly as before", () => {
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(base).success).toBe(true);
    const parsed = E2EApplicationExecutionAdmissionSchema.parse(replayAdmission());
    expect(parsed.replay?.purpose).toBe("replay");
    expect(parsed.modelRoute).toBeNull();
    expect((E2EApplicationExecutionAdmissionSchema.parse(base) as { replay?: unknown }).replay).toBeUndefined();
  });
  it("refuses a replay that names a model route, and a replay that is also a baseline (no model, one purpose)", () => {
    const route = { routeId: "rovara-e2e-default", routeRevision: "r1-0123456789ab" };
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(replayAdmission(replayOf(), { modelRoute: route })).success).toBe(false);
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(replayAdmission(replayOf(), { baseline: { purpose: "baseline", baseCommitSha: base.candidateCommitSha, attempt: 1 } })).success).toBe(false);
  });
  it("binds the recordings: the admission digest covers them, so an edit of one recording after the admission was signed is refused", () => {
    const signedAdmission = replayAdmission();
    const edited = { ...signedAdmission, replay: { ...signedAdmission.replay!, traces: [{ ...signedAdmission.replay!.traces[0]!, traceBase64: file(sha("another")) }] } };
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(edited).success).toBe(false);
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(signedAdmission).success).toBe(true);
    // The marker itself is signed: removing it makes an admission whose digest no longer matches.
    const stripped = { ...signedAdmission } as Record<string, unknown>;
    delete stripped["replay"];
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(stripped).success).toBe(false);
  });
  it("holds the recordings to their bounds: at most twelve, one for a step, canonical base64, a binding for the same case and step, and each source case once", () => {
    expect(E2EApplicationReplaySchema.safeParse(replayOf()).success).toBe(true);
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ traces: Array.from({ length: 13 }, (_, index) => trace(`case-${index}`, 1)) })).success).toBe(false);
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ traces: [trace("case-a", 1), trace("case-a", 1)] })).success).toBe(false);
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ traces: [{ ...trace("case-a", 1), traceBase64: "not base64!" }] })).success).toBe(false);
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ traces: [{ ...trace("case-a", 1), binding: { ...trace("case-a", 1).binding, stepIndex: 2 } }] })).success).toBe(false);
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ traces: [{ ...trace("case-a", 1), extra: true }] })).success).toBe(false);
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ sourceCases: [{ caseId: "a", assertionOutcomes: [], csvSha256: null }, { caseId: "a", assertionOutcomes: [], csvSha256: null }] })).success).toBe(false);
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ attempt: 0 })).success).toBe(false);
  });
  it("REPLAYCAP: the record number a replay admission carries goes up to the record bound (20), not the cap of five started replays; admissions signed at 1 to 5 parse as before", () => {
    expect(E2E_REPLAY_ATTEMPTS_MAX).toBe(5);
    expect(E2E_REPLAY_RECORDS_MAX).toBe(20);
    for (const attempt of [1, 5, 6, 20]) {
      expect(E2EApplicationReplaySchema.safeParse(replayOf({ attempt })).success, `attempt ${attempt}`).toBe(true);
      // The whole signed admission, as the broker encodes it and the worker decodes it.
      expect(E2EApplicationExecutionAdmissionSchema.safeParse(replayAdmission(replayOf({ attempt }))).success, `admission at attempt ${attempt}`).toBe(true);
    }
    expect(E2EApplicationReplaySchema.safeParse(replayOf({ attempt: 21 })).success).toBe(false);
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(replayAdmission(replayOf({ attempt: 21 }))).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse({ ...refBase(), purpose: "replay", sourceRoundId: randomUUID(), attempt: 6 }).success).toBe(true);
  });
});

describe("the executor plan of a replay", () => {
  const sharedAdmission = replayAdmission();
  const replayPlan = (extra: Record<string, unknown> = {}) => ({ ...fixture.plan, admission: sharedAdmission, admissionDigest: e2eExecutorAdmissionDigest(sharedAdmission), ...extra });
  const channel = { protocol: "rovara-e2e-model-channel/v1", socketPath: "/run/rovara/model.sock", routeId: "rovara-e2e-default", routeRevision: "r1-0123456789ab", valueKey: "ab".repeat(32) };
  it("carries the recordings of its admission (`replay`), and a plan with no `replay` is read exactly as before", () => {
    const admission = replayAdmission();
    const plan = { ...fixture.plan, admission, admissionDigest: e2eExecutorAdmissionDigest(admission), replay: { traces: admission.replay!.traces } };
    expect(E2EExecutorPlanSchema.parse(plan).replay?.traces).toHaveLength(1);
    expect(E2EExecutorPlanSchema.parse(fixture.plan).replay).toBeUndefined();
  });
  it("refuses `replay` together with `modelChannel`, in either order of the admission's route", () => {
    const admission = replayAdmission();
    const plan = { ...fixture.plan, admission, admissionDigest: e2eExecutorAdmissionDigest(admission), replay: { traces: admission.replay!.traces } };
    expect(() => E2EExecutorPlanSchema.parse({ ...plan, modelChannel: channel })).toThrow(/replay/);
    const routed = signed({ ...base, replay: replayOf() });
    expect(E2EExecutorPlanSchema.safeParse({ ...fixture.plan, admission: routed, admissionDigest: e2eExecutorAdmissionDigest(routed), replay: { traces: [] }, modelChannel: channel }).success).toBe(false);
  });
  it("needs `replay` for an admission that is a replay and the other way round, and the recordings must be bound exactly as the admission binds them", () => {
    const traces = sharedAdmission.replay!.traces;
    expect(() => E2EExecutorPlanSchema.parse({ ...replayPlan(), replay: undefined })).toThrow(/replay/);
    expect(() => E2EExecutorPlanSchema.parse({ ...fixture.plan, replay: { traces: [] } })).toThrow(/replay/);
    const otherBinding = [{ ...traces[0]!, binding: { ...traces[0]!.binding, traceSha256: sha("another trace") } }];
    expect(() => E2EExecutorPlanSchema.parse({ ...replayPlan(), replay: { traces: otherBinding } })).toThrow(/replay/);
    expect(() => E2EExecutorPlanSchema.parse({ ...replayPlan(), replay: { traces: [...traces, trace("case-b", 1)] } })).toThrow(/replay/);
    expect(() => E2EExecutorPlanSchema.parse({ ...replayPlan(), replay: { traces, extra: true } })).toThrow();
  });
  it("lets an edited recording through the schema: the store, not the schema, refuses bytes that are not the bound ones (they are a miss)", () => {
    const traces = sharedAdmission.replay!.traces;
    const edited = [{ ...traces[0]!, traceBase64: file(sha("edited")) }];
    expect(E2EExecutorPlanSchema.parse({ ...replayPlan(), replay: { traces: edited } }).replay?.traces[0]?.traceBase64).toBe(edited[0]!.traceBase64);
  });
});

describe("the replay result", () => {
  it("is a status, whether it reproduced, whether the download matched, and at most a reason from the closed list", () => {
    expect(E2EReplayResultSchema.parse({ status: "PASS", reproduced: true, downloadSha256Match: true })).toEqual({ status: "PASS", reproduced: true, downloadSha256Match: true });
    expect(E2EReplayResultSchema.parse({ status: "UNKNOWN", reproduced: false, downloadSha256Match: false, reason: "typed-value-not-replayable" }).reason).toBe("typed-value-not-replayable");
    expect(E2EReplayResultSchema.safeParse({ status: "UNKNOWN", reproduced: false, downloadSha256Match: false, reason: "the model said something" }).success).toBe(false);
    expect(E2EReplayResultSchema.safeParse({ status: "PASS", reproduced: true, downloadSha256Match: true, extra: 1 }).success).toBe(false);
  });
});
