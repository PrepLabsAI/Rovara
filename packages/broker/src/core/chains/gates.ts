// A chain's gate is the owner's. `chainGateRequest` is what the owner is shown and what their proof is bound to (the run, the gate's number, its step and its prompt); `decideChainGate` verifies the proof with the
// `Approvers` port and only then records the decision, using the proof up in the same transaction. No step's report, no event and no model can produce a proof, so a run never decides its own gate. A gate that
// is not decided in time takes its reject edge (`sweepChainRuns`).
import { agentXError, type ApprovalProof, type Approvers, type ChainRunId, type OrgId } from "@agentx/contracts";
import { automationRequest, verifyOwnerProof } from "../automation/authority.js";
import { decideGate, readChainRun, readStepAttempts, type ChainRunnerDeps } from "./runner.js";

/** The request for one waiting gate and one answer, built from the STORED run and attempt (never from the caller's words). The proof is bound to the answer: a proof to continue is no proof to stop. */
export async function chainGateRequest(deps: ChainRunnerDeps, orgId: OrgId, runId: ChainRunId, seq: number, decision: "approved" | "declined") {
  const run = await readChainRun(deps, orgId, runId);
  if (run === undefined) throw agentXError("NOT_FOUND", "no chain run has that ID");
  const attempt = (await readStepAttempts(deps, orgId, runId)).find((candidate) => candidate.seq === seq);
  if (attempt === undefined || attempt.kind !== "gate") throw agentXError("NOT_FOUND", "no gate has that number");
  return { run, attempt, request: automationRequest({ companyId: deps.companyId, kind: "chain_gate", subjectId: `${runId}#${String(seq)}`, revision: seq, facts: { runId, seq, stepId: attempt.stepId, stepName: attempt.stepName, chainVersion: run.chainVersion, decision }, project: run.project }) };
}

/** The owner's decision on a waiting gate, with their proof. Refused without a proof the approvers accept. */
export async function decideChainGate(deps: ChainRunnerDeps, approvers: Approvers, orgId: OrgId, runId: ChainRunId, seq: number, decision: "approved" | "declined", proof: ApprovalProof | undefined): Promise<void> {
  const { attempt, request } = await chainGateRequest(deps, orgId, runId, seq, decision);
  if (attempt.status !== "waiting") return;
  const verified = await verifyOwnerProof(approvers, request, proof);
  await decideGate(deps, orgId, runId, seq, decision, verified.approver.displayName, [verified.used]);
}
