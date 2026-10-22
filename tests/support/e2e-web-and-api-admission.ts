import { randomUUID } from "node:crypto";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { buildApplicationExecutionAdmission, type ApplicationAdmission, type ApplicationAdmissionInput } from "../../packages/broker/src/e2e/application-admission.js";
import type { E2EApplicationExecutionAdmission } from "@agentx/contracts";
import { decodeE2EApplicationExecutionAdmission, validateE2EApplicationExecutionAdmission, type ValidatedE2EApplicationAdmission } from "@agentx/verifier";
import { createRealCandidate } from "./e2e-application-candidate.js";
import { binding, oneAppWebAndApiFixture, webApiRow } from "./e2e-application-plan-fixtures.js";

/**
 * The admission the broker builds for one app whose approved plan runs a web scenario and an API scenario (Task 3.4): a real candidate, both runtime rows READY, the approval the Owner gave,
 * and the admission dispatch builds from them. The caller disposes the candidate (`disposeRealCandidates`).
 */
export async function builtWebAndApiAdmission(overrides: Partial<ApplicationAdmissionInput> = {}, plan: { web: boolean; api: boolean } = { web: true, api: true },
  options: { baseline?: boolean } = {}): Promise<{
  fx: ReturnType<typeof oneAppWebAndApiFixture>; intent: ReturnType<ReturnType<typeof oneAppWebAndApiFixture>["build"]>; approved: Extract<ReturnType<typeof evaluateApplicationPlanApproval>, { ok: true }>;
  candidate: Awaited<ReturnType<typeof createRealCandidate>>; input: ApplicationAdmissionInput; built: ApplicationAdmission; admission: E2EApplicationExecutionAdmission;
  validated: ValidatedE2EApplicationAdmission; groupOf: (kind: "web" | "api") => string | undefined }> {
  const fx = oneAppWebAndApiFixture();
  const intent = fx.build(plan);
  const rows = () => [webApiRow("web"), webApiRow("api")];
  const artifact = { id: "feature-plan", sha256: "1".repeat(64) };
  const approved = evaluateApplicationPlanApproval({ intent, taskId: "11111111-1111-4111-8111-111111111111", artifact, snapshot: fx.snapshot, setupProposal: fx.setup.proposal,
    setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: rows(), runtimeCatalogId: "catalog", runtimeBinding: binding, now: Date.now(),
    accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
  if (!approved.ok) throw new Error(approved.reason);
  const candidate = await createRealCandidate({ "package.json": fx.manifest });
  const input: ApplicationAdmissionInput = { taskId: "11111111-1111-4111-8111-111111111111", operationId: randomUUID(), operationFence: 3, workflowRevision: 7, roundId: randomUUID(),
    runId: randomUUID, intent, artifact, snapshot: candidate.snapshot, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval, policy: fx.policy,
    registeredRuntimes: rows(), runtimeCatalogId: "catalog", runtimeBinding: binding, buildSource: candidate.buildSource, planDigest: "c".repeat(64), now: Date.now(),
    accountEntries: fx.registry, recordedSelection: approved.selection,
    ...(options.baseline === true ? { baseline: { baseCommitSha: candidate.snapshot.commitSha, attempt: 1 } } : {}), ...overrides };
  const built = buildApplicationExecutionAdmission(input);
  const admission = decodeE2EApplicationExecutionAdmission(built.bytes);
  const validated = validateE2EApplicationExecutionAdmission(admission);
  const groupOf = (kind: "web" | "api") => validated.applicationSuites.find((suite) => suite.runtimeKind === kind)?.group.groupId;
  return { fx, intent, approved, candidate, input, built, admission, validated, groupOf };
}
