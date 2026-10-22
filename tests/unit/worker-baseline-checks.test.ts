import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { E2EWorkflowAdmissionRef } from "@agentx/contracts";
import { executeWorkflowE2EApplicationChecks } from "../../packages/worker/src/workflow-e2e-application-checks.js";
import { buildApplicationExecutionAdmission, type ApplicationAdmissionInput } from "../../packages/broker/src/e2e/application-admission.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { binding, ordersContractManifest, planFixture, webApiRow } from "../support/e2e-application-plan-fixtures.js";

// M1.3 Task 3.7b: the worker runs a baseline admission only for an invocation whose signed reference says it is a baseline for the same base commit and attempt, and a candidate
// admission only for one that says nothing of the kind. A baseline that is mistaken for a candidate (or the reverse) never reaches Docker.

afterEach(disposeRealCandidates);
const TASK = "11111111-1111-4111-8111-111111111111";
const REACHED = "the runtime was asked for";

async function built(baseline: boolean) {
  const fx = planFixture({});
  const real = await createRealCandidate({ "package.json": ordersContractManifest, "src/orders.js": "export const orders = [];\n" });
  const selection = evaluateApplicationPlanApproval({ intent: fx.intent, taskId: TASK, artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: fx.snapshot, setupProposal: fx.setup.proposal,
    setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(),
    accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
  if (!selection.ok) throw new Error(selection.reason);
  const input: ApplicationAdmissionInput = { taskId: TASK, operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(), runId: randomUUID, intent: fx.intent,
    artifact: { id: "feature-plan", sha256: "1".repeat(64) }, snapshot: real.snapshot, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy: fx.policy,
    registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: real.buildSource, planDigest: "c".repeat(64), now: Date.now(),
    accountEntries: fx.registry, recordedSelection: selection.selection, ...(baseline ? { baseline: { baseCommitSha: real.identity.commitSha, attempt: 1 } } : {}) };
  const admission = buildApplicationExecutionAdmission(input);
  const reference = (extra: Record<string, unknown> = {}): E2EWorkflowAdmissionRef => ({ schemaVersion: 1, kind: "application", taskId: TASK, workflowRevision: 7,
    candidateDigest: admission.admission.candidateDigest, roundId: admission.roundId, groupRunIds: admission.groupRunIds,
    admissionRef: { key: `workflow-e2e-admissions/sha256/${admission.sha256}.json`, sha256: admission.sha256, byteLength: admission.bytes.byteLength }, ...extra });
  return { admission, input, real, reference };
}

const run = (round: Awaited<ReturnType<typeof built>>, reference: E2EWorkflowAdmissionRef) => executeWorkflowE2EApplicationChecks({
  invocation: { kind: "task", operationId: round.input.operationId, fence: round.input.operationFence, payload: { workflowE2EAdmission: reference } } as never,
  reference, admissionBytes: round.admission.bytes, runtime: () => { throw new Error(REACHED); }, candidateRepositoryRoot: () => undefined,
  saveEvidence: async () => { throw new Error("no evidence"); }, throwIfCancelled: () => undefined });

describe("the worker keeps baseline and candidate rounds apart", () => {
  it("runs a baseline admission for a reference that signs the same purpose, base commit and attempt (it reaches the runtime)", async () => {
    const round = await built(true);
    const reference = round.reference({ purpose: "baseline", baseCommitSha: round.real.identity.commitSha, attempt: 1 });
    await expect(run(round, reference)).rejects.toThrow(REACHED);
  });

  it("refuses a baseline admission under a reference that does not say baseline, or says another base commit or attempt", async () => {
    const round = await built(true);
    await expect(run(round, round.reference())).rejects.toThrow(/baseline/i);
    await expect(run(round, round.reference({ purpose: "baseline", baseCommitSha: "a".repeat(40), attempt: 1 }))).rejects.toThrow(/baseline/i);
    await expect(run(round, round.reference({ purpose: "baseline", baseCommitSha: round.real.identity.commitSha, attempt: 2 }))).rejects.toThrow(/baseline/i);
  });

  it("refuses a candidate admission under a reference that says baseline", async () => {
    const round = await built(false);
    await expect(run(round, round.reference({ purpose: "baseline", baseCommitSha: round.real.identity.commitSha, attempt: 1 }))).rejects.toThrow(/baseline/i);
    await expect(run(round, round.reference())).rejects.toThrow(REACHED);
  });
});
