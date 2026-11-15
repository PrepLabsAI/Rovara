// Lane H: "may this person decide this? is the sign-in fresh enough? is a second person needed?" over the `approvers` point (approvals, Keep, sensitive
// settings: every caller of the point). Stricter only, and never cached. No answer refuses at once:
// - `requirement` asks first (stage `requirement`) and can only raise what is needed: more approvers, no self-approval, no sole approver, a fresher sign-in.
//   No answer, or a "no", throws a fixed error, so nothing is decided.
// - `verify` asks for each approved verdict of the install's own approvers (stage `verdict`, with the approver). A "no", no answer, or a sign-in older than the
//   answer allows turns it into a refusal. A claim the verdict holds is given back.
// A "second person needed" answer (owner row 11.5: loosening a setting needs a second admin) means: the person who asked may not approve, no sole-approver
// exception, and at least two approvers when the request names no one who asked.
import {
  POLICY_HOOK_WORDS, agentXError,
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalSignInRule, type ApprovalVerdict, type Approvers, type PolicyHookDecideAnswer, type PolicyHookDecideQuestion, type Principal,
} from "@agentx/contracts";
import type { PolicyHookClient } from "./client.js";

export interface PolicyHookApproversOptions {
  now?: () => number;
}

function decideQuestion(request: ApprovalRequest, stage: "requirement" | "verdict", approver?: Principal): PolicyHookDecideQuestion {
  const auth = approver?.authTime === undefined ? undefined : Date.parse(approver.authTime);
  return {
    cid: request.companyId,
    ...(request.projectName === undefined ? {} : { pid: request.projectName }),
    stage,
    what: request.kind,
    styp: request.subject.type,
    sid: request.subject.id,
    ...(request.risk === undefined ? {} : { risk: request.risk }),
    ...(request.requestedBy === undefined ? {} : { by: request.requestedBy.personId }),
    ...(approver === undefined ? {} : { per: approver.personId }),
    ...(auth === undefined || !Number.isFinite(auth) ? {} : { auth: Math.max(0, Math.floor(auth / 1000)) }),
  };
}

function stricterSignIn(base: ApprovalSignInRule | undefined, seconds: number | undefined): ApprovalSignInRule | undefined {
  if (seconds === undefined) return base;
  if (base?.mode === "window") return { mode: "window", seconds: Math.min(base.seconds, seconds) };
  return { mode: "window", seconds };
}

/** The install's requirement, made only stricter by the answer. */
export function stricterRequirement(base: ApprovalRequirement, answer: PolicyHookDecideAnswer, request: Pick<ApprovalRequest, "requestedBy">): ApprovalRequirement {
  const floor = answer.secondPerson ? (request.requestedBy === undefined ? 2 : 1) : 1;
  const { soleApproverAllowed, signIn, ...rest } = base;
  const nextSignIn = stricterSignIn(signIn, answer.signInMaxAgeSeconds);
  return {
    ...rest,
    minApprovers: Math.max(base.minApprovers, answer.minApprovers, floor),
    selfApprovalAllowed: base.selfApprovalAllowed && answer.selfApproval && !answer.secondPerson,
    ...(nextSignIn === undefined ? {} : { signIn: nextSignIn }),
    ...(soleApproverAllowed === undefined || answer.secondPerson ? {} : { soleApproverAllowed }),
  };
}

export function withPolicyHookApprovers(base: Approvers, hook: PolicyHookClient, options: PolicyHookApproversOptions = {}): Approvers {
  const now = options.now ?? Date.now;
  async function ask(request: ApprovalRequest, stage: "requirement" | "verdict", approver?: Principal): Promise<PolicyHookDecideAnswer | "unaskable" | undefined> {
    const prepared = await hook.prepare("decide", decideQuestion(request, stage, approver));
    if (prepared === undefined) return "unaskable";
    const result = await hook.send(prepared);
    await hook.audit(prepared, result.answered ? { answered: true, allow: result.answer.allow, attempts: 1 } : { answered: false, attempts: 1 });
    return result.answered ? result.answer : undefined;
  }
  const refuse = async (verdict: Extract<ApprovalVerdict, { approved: true }>, reason: string): Promise<ApprovalVerdict> => {
    if (verdict.claimId !== undefined) await base.releaseClaim?.(verdict.claimId).catch(() => undefined);
    return { approved: false, reason };
  };
  const wrapped: Approvers = {
    async requirement(request) {
      const requirement = await base.requirement(request);
      const answer = await ask(request, "requirement");
      if (answer === undefined) throw agentXError("RUNTIME_UNAVAILABLE", POLICY_HOOK_WORDS.decideNoAnswer);
      if (answer === "unaskable" || !answer.allow) throw agentXError("FORBIDDEN", POLICY_HOOK_WORDS.decideRefused);
      return stricterRequirement(requirement, answer, request);
    },
    async verify(request: ApprovalRequest, proof: ApprovalProof) {
      const verdict = await base.verify(request, proof);
      if (!verdict.approved) return verdict;
      const answer = await ask(request, "verdict", verdict.approver);
      if (answer === undefined) return refuse(verdict, "company_rules_no_answer");
      if (answer === "unaskable" || !answer.allow) return refuse(verdict, "company_rules_refused");
      if (answer.signInMaxAgeSeconds !== undefined) {
        const auth = verdict.approver.authTime === undefined ? Number.NaN : Date.parse(verdict.approver.authTime);
        if (!Number.isFinite(auth) || now() - auth > answer.signInMaxAgeSeconds * 1000) return refuse(verdict, "sign_in_not_fresh");
      }
      if (answer.secondPerson) {
        if (request.requestedBy !== undefined && verdict.approver.provider === request.requestedBy.provider && verdict.approver.personId === request.requestedBy.personId) return refuse(verdict, "self_approval_not_allowed");
        const rest: Extract<ApprovalVerdict, { approved: true }> = { ...verdict };
        delete rest.soleApprover;
        return rest;
      }
      return verdict;
    },
  };
  if (base.commitClaim !== undefined) wrapped.commitClaim = (claimId) => base.commitClaim!(claimId);
  if (base.releaseClaim !== undefined) wrapped.releaseClaim = (claimId) => base.releaseClaim!(claimId);
  return wrapped;
}
