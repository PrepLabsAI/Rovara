// L4-D (DEC 254z b; answers Question L2-3 of #844): the hosted approval of a project's setup candidate. "Use this setup" on hosted Code is three steps, as on the laptop (apply.ts):
//   confirm   makes a CANDIDATE revision from the run's verified commands and starts its check on a fresh workspace (nothing applied);
//   check     the candidate's commands run on that workspace; only a passing check makes the candidate wait for a decision;
//   decide    approve (the candidate becomes the project's latest revision) or reject (it is removed), through the ONE approval gate, bound to the candidate's digest and revision.
//
// Who decides is risk-based, replacing the laptop's owner-only rule (setup-risk.ts): the risk is read from the candidate's diff against the project's approved revision, in code; low and medium
// (commands, test mocks) a project maintainer (a company owner or admin, or the project's administrator, including the person whose run found it); high (a website, a secret or credential, a
// registry, an integration, the dev container, anything unknown) a company owner or admin. The standing is the person's LIVE membership and project grant, read for the route's own check and
// again inside the decision (the subject's rule), so a role lost between the two refuses.
//
// The proof: the hosted approvers point's one method, a proof of this one act by the signed-in person (hosted-approvers.ts `issueSetupApprovalProof`), bound to the company, the person, the request id,
// the candidate's revision and digest, the answer and the card `setup_proposal:<project>` at that digest. A candidate that moved (another digest or revision, the project no longer at the base
// revision) is refused by the gate (`stale`) or by the decision's own transaction.
import type { SessionMembers } from "../core/sessions/access.js";
import { type AuditSink, type Approvers, type IdentityProvider, type ObjectStorage, type OrgId, type OrgRole, type DocumentStore } from "@agentx/contracts";
import { createDecisionGate, type Credential, type DecisionGate } from "../core/decisions/approval-gate.js";
import { createSetupProposalSubject } from "../core/setup-agent/apply.js";
import { createBrowserApprovalSteps } from "../core/setup-agent/browser-testing-approval.js";
import { createEvalSpendSubject } from "../core/setup-agent/eval-spend.js";
import { createSetupHostSubject } from "../core/setup-agent/host-ask.js";
import { SETUP_RISK_APPROVER, setupApproverAllows, setupHostApproverAllows, type SetupApproverStanding, type SetupRisk } from "../core/setup-agent/setup-risk.js";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { deployedSessionMembers } from "./deployed-decisions.js";
import { issueEvalSpendApprovalProof, issueSetupHostApprovalProof, issueSetupApprovalProof, type SetupHostApprovalProofInput, type SetupApprovalProofInput } from "./hosted-approvers.js";

export const SETUP_NEEDS_ADMIN = "This setup change reaches outside the project's commands (a website, a secret, a registry, an integration or something Rovara does not recognise), so a company owner or admin must approve it.";
export const SETUP_HOST_NEEDS_ADMIN = "A website for a setup run changes what the project's code can reach, so only a company owner or admin can allow or refuse it.";
export const SETUP_NEEDS_MAINTAINER = "Only the project's maintainers, or a company owner or admin, can decide this setup.";

/** The words of a refusal by the candidate's risk and the answer (any maintainer may reject). */
export const setupApproverRefusal = (risk: SetupRisk, outcome: "approve" | "reject"): string => (outcome === "approve" && SETUP_RISK_APPROVER[risk] === "admin" ? SETUP_NEEDS_ADMIN : SETUP_NEEDS_MAINTAINER);

/** The request id a page decides a waiting candidate under: one per candidate digest and revision (the laptop's rule, local/app/setup-agent.ts `proposalRequestId`). */
export const setupDecisionRequestId = (digest: string, candidateRevision: number): string => `setup-${digest.slice(0, 40)}-${String(candidateRevision)}`;

/** The card a candidate is decided on, at the digest the person saw (the hosted approvers point checks the proof was issued for it). */
export const setupCardOf = (project: string, artifactDigest: string): { cardId: string; contentVersion: string } => ({ cardId: `setup_proposal:${project}`, contentVersion: artifactDigest });

/** The card a website ask is decided on, at the digest the person saw (the host and when it was asked): the hosted approvers point checks the proof was issued for it. */
export const setupHostCardOf = (subjectId: string, artifactDigest: string): { cardId: string; contentVersion: string } => ({ cardId: `setup_host:${subjectId}`, contentVersion: artifactDigest });

/** The card an eval spend item is decided on, at the digest the person saw (L4-EVC; the hosted approvers point checks the proof was issued for it). */
export const evalSpendCardOf = (project: string, artifactDigest: string): { cardId: string; contentVersion: string } => ({ cardId: `eval_spend:${project}`, contentVersion: artifactDigest });

/** What the hosted setup route needs to decide a candidate, and a website ask. */
export interface HostedSetupApproval {
  /** The approval gate over the company's approvers point, with the hosted setup subject (risk from the diff, the live standing rule). */
  gate: DecisionGate;
  /** The approvers point's proof of one act. Throws when it cannot be issued (the route refuses). */
  issue: (act: SetupApprovalProofInput) => Credential | Promise<Credential>;
  /** L4-SF (d): the approvers point's proof of one act on a website ask (bound to the ask's id, digest, answer and card). Throws when it cannot be issued (the route refuses). */
  issueHost: (act: SetupHostApprovalProofInput) => Credential | Promise<Credential>;
  /** L4-EVC: the same proof, for one act on the project's eval spend item (its own subject: a setup proof can never stand for it). Decided through the same gate and the eval subject's live rule (owner, admin or the project's maintainer). */
  issueEval: (act: SetupApprovalProofInput) => Credential | Promise<Credential>;
  /** L4-EVC: the company's live members as the eval seams read them (the same people as `standing`). */
  evalMembers: SessionMembers;
  /** The person's live standing in THIS company on the project. Undefined: not a live member here. Throws when it cannot be read (the route refuses). */
  standing: (personId: string, project: string) => Promise<SetupApproverStanding | undefined>;
}

/** The company's own records of its people, as the deployment reads them (aws/core-engine-root.ts `DeployedPeople`). */
export interface SetupApprovalPeople {
  membershipOf: (personId: string) => Promise<{ companyId: OrgId; role: OrgRole } | undefined>;
  projectGrantRole: (personId: string, project: string) => Promise<"developer" | "administrator" | undefined>;
}

/** The person's live standing in `companyId`, from membership and the project grant. A membership of another company, or a role it does not know, is none. */
export function setupApproverStandingFrom(people: SetupApprovalPeople, companyId: OrgId): HostedSetupApproval["standing"] {
  return async (personId, project) => {
    const membership = await people.membershipOf(personId);
    if (membership === undefined || membership === null || membership.companyId !== companyId) return undefined;
    if (membership.role !== "owner" && membership.role !== "admin" && membership.role !== "member") return undefined;
    const grant = await people.projectGrantRole(personId, project);
    return { companyRole: membership.role, ...(grant === "administrator" || grant === "developer" ? { projectGrant: grant } : {}) };
  };
}

export interface HostedSetupApprovalOptions {
  /** The company's flow (its store, clock and company). */
  flow: Pick<TaskFlowDeps, "store" | "now" | "companyId">;
  store: DocumentStore;
  /** The registry's approvers point (the hosted proof point, behind the policy hook's stricter-only wrapper when sealed so). */
  approvers: Approvers;
  audit: AuditSink;
  identity?: Pick<IdentityProvider, "capabilities">;
  people: SetupApprovalPeople;
  /** The install's approval proof key (`approvalProofKeyOf`). */
  proofKey: Buffer;
  /** L4-SF (c): the other copy of the project's revisions an approval keeps in step (the old broker's registry, aws/setup-registry-mirror.ts). Absent: none. */
  registryMirror?: NonNullable<Parameters<typeof createSetupProposalSubject>[0]["approval"]>["registryMirror"];
  /**
   * Browser testing: the company's object storage, where a browser testing candidate's stored proposal is read again at its approval. Absent: a browser testing candidate cannot be approved here (it is
   * refused, never decided by the ordinary risk rule).
   */
  objects?: ObjectStorage;
  now: () => Date;
}

/** The hosted setup approval for one company (see the file comment). */
export function createHostedSetupApproval(options: HostedSetupApprovalOptions): HostedSetupApproval {
  const companyId = options.flow.companyId;
  const standing = setupApproverStandingFrom(options.people, companyId);
  const subject = createSetupProposalSubject({
    flow: options.flow,
    approval: {
      riskFromDiff: true,
      // Read live inside the decision: the approver the point vouched for, in this company, at the candidate's risk.
      mayDecide: async (approver, input) => approver.companyId === companyId && setupApproverAllows(await standing(approver.personId, input.project), input.risk, input.outcome),
      refusal: setupApproverRefusal,
      ...(options.registryMirror === undefined ? {} : { registryMirror: options.registryMirror }),
      // Browser testing is decided by a live company owner or admin only (read now, here), and its approval writes the policy, the approval and the test accounts in the decision's own transaction.
      ...(options.objects === undefined ? {} : { browserTesting: createBrowserApprovalSteps({ store: options.store, companyId, objects: options.objects, standing }) }),
    },
  });
  // L4-SF (d): a website ask is high risk always, so a company owner or admin decides it (either answer), on their live standing read inside the decision. The ask's own checks (no private, paste or
  // tunnel names; the refusal list read again on approval) are the host-ask subject's, unchanged.
  const hostSubject = createSetupHostSubject({
    store: options.store,
    approval: { mayDecide: async (approver, input) => approver.companyId === companyId && setupHostApproverAllows(await standing(approver.personId, input.project)), refusal: SETUP_HOST_NEEDS_ADMIN },
  });
  // L4-EVC: the project's eval spend item, decided by a company owner or admin or the project's maintainer, read live inside the decision (eval-spend.ts `roleFor`).
  const evalMembers = deployedSessionMembers(companyId, options.people);
  const gate = createDecisionGate({
    store: options.store, approvers: options.approvers, audit: options.audit, subjects: [subject, hostSubject, createEvalSpendSubject({ store: options.store, companyId, members: evalMembers })], now: options.now,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  });
  return {
    gate, standing, evalMembers,
    issue: (act) => issueSetupApprovalProof(options.proofKey, act, options.now().getTime()),
    issueHost: (act) => issueSetupHostApprovalProof(options.proofKey, act, options.now().getTime()),
    issueEval: (act) => issueEvalSpendApprovalProof(options.proofKey, act, options.now().getTime()),
  };
}
