import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2EApplicationExecutionAdmissionSchema, E2EWorkflowAdmissionRefSchema, canonicalJson } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission, validateE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { buildApplicationExecutionAdmission, type ApplicationAdmissionInput } from "../../packages/broker/src/e2e/application-admission.js";
import { ApplicationDispatchRefusal } from "../../packages/broker/src/e2e/application-dispatch-check.js";
import { verifyApplicationE2EEvidence } from "../../packages/broker/src/e2e/application-evidence.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { binding, ordersContractManifest, planFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";

// M1.3 Task 3.7b, review finding F1: a baseline round (the approved scenarios on the unchanged code) is a round of its own kind. Its purpose and the base commit are signed
// into the admission and into the operation's reference, so nothing downstream can mistake it for a candidate round, and the candidate's verification refuses it.

afterEach(disposeRealCandidates);

const ordersTree = { "package.json": ordersContractManifest, "src/orders.js": "export const orders = [];\n" };
const TASK = "11111111-1111-4111-8111-111111111111";

function approvedSelection(fx: ReturnType<typeof planFixture>) {
  const result = evaluateApplicationPlanApproval({ intent: fx.intent, taskId: TASK, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: fx.snapshot,
    setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding,
    now: Date.now(), accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
  if (!result.ok) throw new Error(result.reason);
  return result.selection;
}

async function inputs(overrides: Partial<ApplicationAdmissionInput> = {}) {
  const fx = planFixture({});
  const base = await createRealCandidate(ordersTree);
  const input: ApplicationAdmissionInput = { taskId: TASK, operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(), runId: randomUUID,
    intent: fx.intent, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: base.snapshot, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval,
    policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: base.buildSource, planDigest: "c".repeat(64),
    now: Date.now(), accountEntries: fx.registry, recordedSelection: approvedSelection(fx), ...overrides };
  return { fx, base, input };
}
const baselineOf = (commitSha: string) => ({ baseCommitSha: commitSha, attempt: 1 });

describe("a baseline admission signs its purpose and the base commit", () => {
  it("carries purpose baseline, the base commit and the attempt in the admission, which the worker's own decoder and validator accept", async () => {
    const { input, base } = await inputs();
    const built = buildApplicationExecutionAdmission({ ...input, baseline: baselineOf(base.identity.commitSha) });
    const decoded = decodeE2EApplicationExecutionAdmission(built.bytes);
    validateE2EApplicationExecutionAdmission(decoded);
    expect(decoded.baseline).toEqual({ purpose: "baseline", baseCommitSha: base.identity.commitSha, attempt: 1 });
    expect(decoded.candidateCommitSha).toBe(base.identity.commitSha);
    expect(built.baseline).toEqual({ purpose: "baseline", baseCommitSha: base.identity.commitSha, attempt: 1 });
  });

  it("signs it: the admission digest covers the baseline marker, so the same round as a candidate round has another digest", async () => {
    const { input, base } = await inputs({ operationId: "22222222-2222-4222-8222-222222222222", roundId: "33333333-3333-4333-8333-333333333333", runId: () => "44444444-4444-4444-8444-444444444444" });
    const candidateRound = buildApplicationExecutionAdmission(input);
    const baselineRound = buildApplicationExecutionAdmission({ ...input, baseline: baselineOf(base.identity.commitSha) });
    expect(baselineRound.admissionDigest).not.toBe(candidateRound.admissionDigest);
    const { admissionDigest, ...body } = baselineRound.admission;
    expect(admissionDigest).toBe(createHash("sha256").update(canonicalJson(body)).digest("hex"));
    expect(candidateRound.admission.baseline).toBeUndefined();
    expect(candidateRound.baseline).toBeUndefined();
  });

  it("refuses to sign a base commit that is not the commit of the source the round builds from", async () => {
    const { input } = await inputs();
    let thrown: unknown;
    try { buildApplicationExecutionAdmission({ ...input, baseline: baselineOf("a".repeat(40)) }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ApplicationDispatchRefusal);
    expect((thrown as Error).message).toMatch(/base commit/i);
  });

  it("refuses an admission whose baseline marker was edited after it was signed, or does not name the admitted commit", async () => {
    const { input, base } = await inputs();
    const built = buildApplicationExecutionAdmission({ ...input, baseline: baselineOf(base.identity.commitSha) });
    const edited = { ...built.admission, baseline: { purpose: "baseline", baseCommitSha: "b".repeat(40), attempt: 1 } };
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(edited).success).toBe(false);
    const stripped = (({ baseline: _baseline, ...rest }) => { void _baseline; return rest; })(built.admission);
    expect(E2EApplicationExecutionAdmissionSchema.safeParse(stripped).success).toBe(false);
  });
});

describe("the operation's reference signs the purpose too", () => {
  const ref = (extra: Record<string, unknown>) => ({ schemaVersion: 1, kind: "application", taskId: TASK, workflowRevision: 7, candidateDigest: "d".repeat(64), roundId: randomUUID(), groupRunIds: [randomUUID()],
    admissionRef: { key: `workflow-e2e-admissions/sha256/${"e".repeat(64)}.json`, sha256: "e".repeat(64), byteLength: 1000 }, ...extra });

  it("accepts a baseline reference only with the base commit and the attempt, and a candidate reference only without them", () => {
    expect(E2EWorkflowAdmissionRefSchema.safeParse(ref({ purpose: "baseline", baseCommitSha: "a".repeat(40), attempt: 1 })).success).toBe(true);
    expect(E2EWorkflowAdmissionRefSchema.safeParse(ref({})).success).toBe(true);
    expect(E2EWorkflowAdmissionRefSchema.safeParse(ref({ purpose: "baseline" })).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse(ref({ purpose: "baseline", baseCommitSha: "a".repeat(40) })).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse(ref({ baseCommitSha: "a".repeat(40), attempt: 1 })).success).toBe(false);
    expect(E2EWorkflowAdmissionRefSchema.safeParse(ref({ purpose: "candidate", baseCommitSha: "a".repeat(40), attempt: 1 })).success).toBe(false);
  });

  it("only an application reference can be a baseline", () => {
    const portable = ref({ purpose: "baseline", baseCommitSha: "a".repeat(40), attempt: 1 });
    delete (portable as { kind?: string }).kind;
    expect(E2EWorkflowAdmissionRefSchema.safeParse(portable).success).toBe(false);
  });
});

describe("verification keeps the two kinds of round apart", () => {
  const subjectOf = (built: ReturnType<typeof buildApplicationExecutionAdmission>, input: ApplicationAdmissionInput) => ({ taskId: input.taskId, operationId: input.operationId, operationFence: input.operationFence,
    workflowRevision: input.workflowRevision, candidateDigest: built.admission.candidateDigest, roundId: built.roundId, groupRunIds: built.groupRunIds, admissionSha256: built.sha256 });
  const verify = (built: ReturnType<typeof buildApplicationExecutionAdmission>, input: ApplicationAdmissionInput, purpose?: "candidate" | "baseline") => verifyApplicationE2EEvidence({
    admissionBytes: built.bytes, subject: subjectOf(built, input), aggregate: undefined, groupEvidence: new Map(), receivedAt: new Map(), terminalStatus: "SUCCEEDED", ...(purpose === undefined ? {} : { purpose }) });

  it("never reads a baseline admission as a candidate round: UNKNOWN, with the reason", async () => {
    const { input, base } = await inputs();
    const built = buildApplicationExecutionAdmission({ ...input, baseline: baselineOf(base.identity.commitSha) });
    for (const purpose of [undefined, "candidate" as const]) {
      const verified = verify(built, input, purpose);
      expect(verified.verdict).toBe("UNKNOWN");
      expect(verified.reason).toMatch(/baseline/i);
      expect(verified.display).toBeUndefined();
    }
  });

  it("never reads a candidate admission as a baseline round either", async () => {
    const { input } = await inputs();
    const built = buildApplicationExecutionAdmission(input);
    const verified = verify(built, input, "baseline");
    expect(verified.verdict).toBe("UNKNOWN");
    expect(verified.reason).toMatch(/baseline|purpose/i);
  });

  it("reads a baseline admission as a baseline once the purpose it was signed with is the purpose asked for (the evidence is then what decides)", async () => {
    const { input, base } = await inputs();
    const built = buildApplicationExecutionAdmission({ ...input, baseline: baselineOf(base.identity.commitSha) });
    const verified = verify(built, input, "baseline");
    // No evidence was uploaded, so the round is not whole; the point is that the refusal above is about the purpose, not this.
    expect(verified.reason).not.toMatch(/purpose/i);
    expect(verified.display).toBeDefined();
  });
});
