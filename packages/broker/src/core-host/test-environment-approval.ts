// L4-B3b (DEC 254zm item 4, live): the hosted approval of a project's test environment for one company. It joins what the earlier lanes built:
//   - the test environment's own decision subject (core/test-env/environment.ts), given a host rule that reads the approver's LIVE company role and project grant against the proposal's risk
//     (DEC 254z b, hosted-test-environment-decision.ts `mayApproveTestEnvironment`): low and medium, a company owner or admin or the project's maintainer; high, a company owner or admin;
//   - the ONE approval gate over the company's approvers point (the hosted step-up point, behind the policy hook's stricter-only wrapper when sealed so);
//   - the approvers point's proof of one act, with its own subject marker (hosted-approvers.ts `issueTestEnvironmentStepUpApproval`): a fresh step-up bound to the company, the person, the
//     request id, the proposal's digest, the revision its approval makes, the answer and the card `test-environment:<project>` at that digest.
// The route (dev-routes.ts) checks the step-up on the verified access token and the person's right to read the project; the decider checks the roles and the proposal; the gate verifies the
// proof and the subject re-checks the roles inside the decision.
import type { Approvers, AuditSink, DocumentStore, IdentityProvider, OrgId } from "@agentx/contracts";
import { createDecisionGate } from "../core/decisions/approval-gate.js";
import type { TestEnvDeps } from "../core/test-env/deps.js";
import { createTestEnvironmentSubject } from "../core/test-env/environment.js";
import { liveGrant, liveMemberRole, type DeployedPeople } from "./deployed-decisions.js";
import { issueTestEnvironmentStepUpApproval } from "./hosted-approvers.js";
import { createHostedTestEnvironmentDecision, TEST_ENVIRONMENT_NOT_ALLOWED, mayApproveTestEnvironment, testEnvironmentCardOf, type HostedTestEnvironmentDecider } from "./hosted-test-environment-decision.js";

export { testEnvironmentCardOf };

export interface HostedTestEnvironmentApprovalOptions {
  companyId: OrgId;
  /** The company's own records and the install's switches (the same deps the state read uses). */
  deps: TestEnvDeps;
  store: DocumentStore;
  /** The registry's approvers point (the hosted step-up point). */
  approvers: Approvers;
  audit: AuditSink;
  identity?: Pick<IdentityProvider, "capabilities">;
  people: DeployedPeople;
  /** The install's step-up proof key (`stepUpApprovalKeyOf`). */
  proofKey: Buffer;
  now: () => Date;
}

/** The hosted test environment approval for one company (see the file comment). */
export function createHostedTestEnvironmentApproval(options: HostedTestEnvironmentApprovalOptions): HostedTestEnvironmentDecider {
  const { companyId, people } = options;
  const subject = createTestEnvironmentSubject(options.deps, {
    companyId,
    approval: {
      // Read live inside the decision: the approver the point vouched for, in THIS company, at the proposal's risk. A role or grant that is gone, or a read that fails, is a refusal.
      mayDecide: async (approver, input) => approver.companyId === companyId && mayApproveTestEnvironment({
        companyRole: await liveMemberRole(people, companyId, approver.personId), projectRole: await liveGrant(people, approver.personId, input.project), risk: input.risk,
      }),
      refusal: TEST_ENVIRONMENT_NOT_ALLOWED,
    },
  });
  const gate = createDecisionGate({
    store: options.store, approvers: options.approvers, audit: options.audit, subjects: [subject], now: options.now,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
  });
  return createHostedTestEnvironmentDecision({
    companyId, deps: options.deps, gate: () => gate, people,
    proofs: { issue: (input) => issueTestEnvironmentStepUpApproval(options.proofKey, input, options.now().getTime()) },
  });
}
