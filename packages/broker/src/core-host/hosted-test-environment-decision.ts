// DEC 254zm (item 4): approving a project's test environment on Code's AWS deployment, through the existing approval gate and the test environment's own decision subject
// (core/test-env/environment.ts `createTestEnvironmentSubject`, kind `test-environment`): the same subject, the same stored rows, the same single-use proof and replay rules as the laptop's page.
//
// WHO (DEC 254z b, the risk-based approvers L4-D builds for setup): a proposal's risk is the subject's own (`testEnvApprovalRisk`; a less-safe change or a proposal a setup run made is high). A new service
// container is MEDIUM. Low and medium: a live company owner or admin, or the project's maintainer (the broker's `administrator` grant). High: a live company owner or admin only. A project developer, a
// non-member, a revoked member and a person of another company decide nothing. Every role is read LIVE at the act (never from a token or a body).
//
// HOW: a fresh step-up, checked by the route on the verified access token and passed in; then a proof of exactly this act from the deployment's approvers point (`TestEnvironmentProofIssuer`), presented
// to the gate, whose Approvers seam verifies it again. The proof issuer is a SEAM: today the hosted approvers point (core-host/hosted-approvers.ts) accepts task subjects only, and L4-D
// (pr/l4-setup-approval) is extending it to a project's setup candidate. The test environment subject joins that extension (a proof marked for `test-environment`, verified against the project and the
// digest) once it lands; until then no issuer is wired, and the decision answers `not_wired` (fixed words): nothing is approved on AWS by any other path.
//
// What is bound: the project, the proposal's digest, the revision approving it makes, and the request id the person saw. A proposal that changed, was not proved, or is not the one shown is refused
// before any proof is issued. Answers are fixed words; nothing from the request is echoed.
import type { ApprovalCardRef, DecisionRisk, OrgId, OrgRole } from "@agentx/contracts";
import type { DecisionGate, GateResult } from "../core/decisions/approval-gate.js";
import type { TestEnvDeps } from "../core/test-env/deps.js";
import { TEST_ENVIRONMENT_KIND, testEnvironmentSubjectId } from "../core/test-env/environment.js";
import { testEnvironmentView } from "../core/test-env/local-view.js";
import { testEnvironmentEnabled } from "../core/test-env/switch.js";
import type { DeployedPeople } from "./deployed-decisions.js";

/** The approval kind the test environment subject asks the approvers point about (environment.ts: `kind: "setting"`). */
export const TEST_ENVIRONMENT_APPROVAL_KIND = "setting";

/** The proof seam: the deployment's approvers point issues a proof of exactly this act (L4-D's extension of hosted-approvers.ts). Throws on an input it cannot bind. */
export interface TestEnvironmentProofIssuer {
  issue(input: {
    companyId: OrgId; personId: string; stepUp: { at: string; method: string }; requestId: string; kind: typeof TEST_ENVIRONMENT_APPROVAL_KIND;
    project: string; revision: number; artifactDigest: string; outcome: "approve"; card: ApprovalCardRef;
  }): { method: string; token: string };
}

/** Whether a person with these live roles may approve a proposal of this risk (see the file comment). Pure. */
export function mayApproveTestEnvironment(input: { companyRole: OrgRole | undefined; projectRole: "developer" | "administrator" | undefined; risk: DecisionRisk }): boolean {
  if (input.companyRole === undefined) return false;
  const companyAdmin = input.companyRole === "owner" || input.companyRole === "admin";
  if (input.risk === "low" || input.risk === "medium") return companyAdmin || input.projectRole === "administrator";
  return companyAdmin;
}

export type HostedTestEnvironmentDecision =
  | { ok: true; message: string }
  | { ok: false; reason: "not_wired" | "off" | "not_found" | "stale" | "not_allowed" | "refused"; message: string };

const WORDS = {
  not_wired: "Approving a test environment is not on this install yet.",
  off: "The test environment is switched off on this install.",
  not_found: "That is no longer there.",
  stale: "It changed while you were looking. Open it again.",
  not_allowed: "Only a company admin, or the project's maintainer for a low or medium risk change, can approve this test environment.",
  refused: "That could not be approved.",
} as const;
const refuse = (reason: Exclude<HostedTestEnvironmentDecision, { ok: true }>["reason"]): HostedTestEnvironmentDecision => ({ ok: false, reason, message: WORDS[reason] });

const PROJECT = /^[A-Za-z0-9._-]{1,100}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;

export interface HostedTestEnvironmentDecisionOptions {
  companyId: OrgId;
  /** The company's own records and the install's switches (`env`). */
  deps: TestEnvDeps;
  /** The decision gate over the registry's approvers point, with the test environment subject among its subjects. */
  gate: () => DecisionGate;
  people: DeployedPeople;
  /** Absent until the approvers point can prove a test environment act (L4-D): every decision answers `not_wired`. */
  proofs?: TestEnvironmentProofIssuer | undefined;
}

export interface HostedTestEnvironmentDecider {
  approve(input: { personId: string; stepUp: { at: string; method: string } | undefined; project: string; approval: { requestId: string; revision: number; artifactDigest: string } }): Promise<HostedTestEnvironmentDecision>;
}

export function createHostedTestEnvironmentDecision(options: HostedTestEnvironmentDecisionOptions): HostedTestEnvironmentDecider {
  const { companyId, deps, people } = options;
  return {
    async approve(input) {
      const proofs = options.proofs;
      if (proofs === undefined) return refuse("not_wired");
      if (!testEnvironmentEnabled(deps.env ?? process.env)) return refuse("off");
      const { project, approval } = input;
      if (typeof project !== "string" || !PROJECT.test(project) || typeof approval?.artifactDigest !== "string" || !DIGEST.test(approval.artifactDigest)
        || typeof approval.requestId !== "string" || !REQUEST_ID.test(approval.requestId) || !Number.isSafeInteger(approval.revision) || approval.revision < 1) return refuse("not_found");
      // The step-up is the route's check; without one nothing is issued.
      if (input.stepUp === undefined) return refuse("not_allowed");
      // Who, live: the company membership (this company's) and the project grant. A read that fails decides nothing.
      let companyRole: OrgRole | undefined;
      let projectRole: "developer" | "administrator" | undefined;
      try {
        const membership = await people.membershipOf(input.personId);
        companyRole = membership?.companyId === companyId ? membership.role : undefined;
        projectRole = companyRole === undefined ? undefined : await people.projectGrantRole(input.personId, project);
      } catch {
        return refuse("not_allowed");
      }
      if (companyRole === undefined) return refuse("not_found");
      // What: the proposal that waits now, as stored. Only a proved proposal with the digest and revision the person saw can be approved.
      let proposal;
      try {
        proposal = (await testEnvironmentView(deps, companyId, project)).proposal;
      } catch {
        return refuse("not_found");
      }
      if (proposal === undefined) return refuse("not_found");
      if (proposal.digest !== approval.artifactDigest || proposal.nextRevision !== approval.revision || !proposal.proved) return refuse("stale");
      if (!mayApproveTestEnvironment({ companyRole, projectRole, risk: proposal.risk })) return refuse("not_allowed");
      let credential: { method: string; token: string };
      try {
        credential = proofs.issue({
          companyId, personId: input.personId, stepUp: input.stepUp, requestId: approval.requestId, kind: TEST_ENVIRONMENT_APPROVAL_KIND, project,
          revision: approval.revision, artifactDigest: approval.artifactDigest, outcome: "approve", card: { cardId: `test-environment:${project}`, contentVersion: approval.artifactDigest },
        });
      } catch {
        return refuse("refused");
      }
      let result: GateResult;
      try {
        result = await options.gate().decide({
          companyId, kind: TEST_ENVIRONMENT_KIND, subjectId: testEnvironmentSubjectId(project, approval.artifactDigest), requestId: approval.requestId, outcome: "approve",
          seen: { revision: approval.revision, artifactDigest: approval.artifactDigest }, credentials: [credential], details: {},
          card: { cardId: `test-environment:${project}`, contentVersion: approval.artifactDigest },
        });
      } catch {
        return refuse("refused");
      }
      if (result.status === "decided") return { ok: true, message: "Approved. Tasks that start from now on use it." };
      if (result.status === "refused" && (result.reason === "stale" || result.reason === "not_waiting")) return refuse("stale");
      return refuse("refused");
    },
  };
}
