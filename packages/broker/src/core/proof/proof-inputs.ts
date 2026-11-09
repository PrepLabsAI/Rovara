// Playbook P1: what the Proof section needs from storage, read where the version 2 description is built or rewritten: the approved plan (when it is a structured one with claims), the rows of the task's
// browser and API round for the current code, and the test proof (does a new test fail on the original code?). Informational: a fault in any of them only leaves that input out, so the description is
// published without it; none of them can block a pull request or change a verdict.
import type { E2EScenarioResults, WorkflowSnapshot } from "@agentx/contracts";
import type { OperationFacts } from "../../developer/task-records.js";
import type { TestProofActions } from "../../developer/test-proof-lines.js";
import type { LoadedDocument } from "../../developer/plan-document-reader.js";
import type { ProofContext, ProofDesignContext } from "./proof-section.js";
import type { ProofEvidenceContext } from "./evidence-lines.js";
import { loadTestProof } from "./test-proof-reader.js";

export interface ProofInputsDeps {
  actions: TestProofActions;
  /** The task's browser and API rows; read only when the workflow requires that round. */
  scenarioResults?: (() => Promise<E2EScenarioResults | undefined>) | undefined;
  /** Proof and evidence (wire-proof): the evidence kept for this code and how the pull request shows it. Present only while the proof switch is on; absent, the section is built exactly as it was. */
  evidence?: ((candidateDigest: string) => Promise<ProofEvidenceContext | undefined>) | undefined;
  /** Design review (DR12): the approved design and how it was reviewed and approved (the design-review lane builds it). Absent, or undefined for a task without an approved design, the section is built exactly as it was. */
  design?: ((workflow: WorkflowSnapshot) => Promise<ProofDesignContext | undefined>) | undefined;
}

/**
 * The Proof section's inputs for a version 2 workflow, or undefined when there is no approved structured plan with claims (nothing is read then, and the description has no Proof section).
 * `operations`: the task's operations if the caller already has them (they are not read again). The test proof is looked for only when checks were recorded for the current code: the worker's proof
 * is written with a checks run, and the table reads it only to say a passed check also fails on the original code, which needs a passed check for this code. The proof and the scenario rows are read together.
 */
export async function loadProofContext(
  deps: ProofInputsDeps, task: { ownerKey: string; workspaceId: string }, workflow: WorkflowSnapshot, approvedPlan: LoadedDocument | undefined, operations?: readonly OperationFacts[],
): Promise<ProofContext | undefined> {
  const plan = approvedPlan?.format === "structured" ? approvedPlan.plan : undefined;
  if (plan === undefined || plan.claims.length === 0) return undefined;
  const digest = workflow.candidate?.digest;
  const checked = digest !== undefined && workflow.verification?.candidateDigest === digest;
  const scenarios = async (): Promise<ProofContext["scenarioRows"]> => {
    if (workflow.e2e?.required !== true || deps.scenarioResults === undefined) return undefined;
    try { return (await deps.scenarioResults())?.scenarios; } catch { return undefined; }
  };
  // Evidence is read only for code whose checks were recorded; a fault leaves it out like any other input.
  const evidenceOf = async (): Promise<ProofEvidenceContext | undefined> => {
    if (!checked || digest === undefined || deps.evidence === undefined) return undefined;
    try { return await deps.evidence(digest); } catch { return undefined; }
  };
  // Design review is informational like every other input: a fault leaves the design line out and nothing else.
  const designOf = async (): Promise<ProofDesignContext | undefined> => {
    if (deps.design === undefined) return undefined;
    try { return await deps.design(workflow); } catch { return undefined; }
  };
  const [testProof, scenarioRows, evidence, design] = await Promise.all([checked ? loadTestProof(deps.actions, task, digest, operations) : Promise.resolve(undefined), scenarios(), evidenceOf(), designOf()]);
  return { plan, ...(scenarioRows === undefined ? {} : { scenarioRows }), ...(testProof === undefined ? {} : { testProof }), ...(evidence === undefined ? {} : { evidence }), ...(design === undefined ? {} : { design }) };
}
