// Lane H: "may this person decide this? is the sign-in fresh enough? is a second person needed?" over the `approvers` point (approvals, Keep, sensitive
// settings: every caller of the point). Stricter only. Only a real decision asks (controller, 2026-11-15): `verify`, once per approved verdict of the install's
// own approvers. `requirement` is also read by pages and probes, so it never asks: it answers the last requirement the service gave for this company, project,
// kind and risk, or, when none is known, the stricter default (a second person needed). `verify` then checks that the requirement handed out for this request
// was at least as strict as the fresh answer; when it was looser (rules got stricter), the verdict is refused and the next `requirement` carries the new rule.
// No answer, a "no", or a sign-in older than the answer allows refuses at once; a claim the verdict holds is given back.
// A "second person needed" answer (owner row 11.5: loosening a setting needs a second admin) means: the person who asked may not approve, no sole-approver
// exception, and at least two approvers when the request names no one who asked.
import {
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalSignInRule, type ApprovalVerdict, type Approvers, type PolicyHookDecideAnswer, type PolicyHookDecideQuestion, type Principal,
} from "@agentx/contracts";
import type { PolicyHookClient } from "./client.js";

/** A sign-in time this far ahead of the clock is not believed. */
const SIGN_IN_SKEW_MS = 30_000;

export interface PolicyHookApproversOptions {
  now?: () => number;
  /** At most this many known requirements and handed-out requirements are remembered. */
  maxEntries?: number;
}

/** The stricter default, used for a requirement before the service has answered for its kind: a second person needed. */
export const STRICTER_DEFAULT_ANSWER: PolicyHookDecideAnswer = Object.freeze({ allow: true, minApprovers: 1, secondPerson: true, selfApproval: false });

/** Whether the requirement a caller counted with (`used`) is at least as strict as `fresh` in everything the hook can raise. */
export function requirementCovers(used: ApprovalRequirement, fresh: ApprovalRequirement): boolean {
  if (used.minApprovers < fresh.minApprovers) return false;
  if (used.selfApprovalAllowed && !fresh.selfApprovalAllowed) return false;
  if (used.soleApproverAllowed === true && fresh.soleApproverAllowed !== true) return false;
  if (fresh.signIn?.mode === "window" && (used.signIn?.mode !== "window" || used.signIn.seconds > fresh.signIn.seconds)) return false;
  return true;
}

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
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
    // The sole-approver exception skips the count and the self check, so any answer that asks for more than the install keeps it off.
    ...(soleApproverAllowed === undefined || answer.secondPerson || !answer.selfApproval || answer.minApprovers > base.minApprovers ? {} : { soleApproverAllowed }),
  };
}

export function withPolicyHookApprovers(base: Approvers, hook: PolicyHookClient, options: PolicyHookApproversOptions = {}): Approvers {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1000;
  /** The last answer the service gave, by company, project, kind, subject type and risk. */
  const known = new Map<string, PolicyHookDecideAnswer>();
  /** The requirement handed out for each request id, so `verify` knows what the caller counts with. */
  const handedOut = new Map<string, ApprovalRequirement>();
  const kindKey = (request: ApprovalRequest): string => JSON.stringify([request.companyId, request.projectName ?? "", request.kind, request.subject.type, request.risk ?? ""]);
  const requestKey = (request: ApprovalRequest): string => JSON.stringify([request.companyId, request.requestId]);
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
      // Never asks: pages and probes read this. The last known answer, or the stricter default.
      const requirement = stricterRequirement(await base.requirement(request), known.get(kindKey(request)) ?? STRICTER_DEFAULT_ANSWER, request);
      remember(handedOut, requestKey(request), requirement, maxEntries);
      return requirement;
    },
    async verify(request: ApprovalRequest, proof: ApprovalProof) {
      const verdict = await base.verify(request, proof);
      if (!verdict.approved) return verdict;
      const answer = await ask(request, "verdict", verdict.approver);
      if (answer === undefined) return refuse(verdict, "company_rules_no_answer");
      if (answer === "unaskable") return refuse(verdict, "company_rules_refused");
      // Every signed answer is the last known one for this kind, which the next `requirement` reads.
      remember(known, kindKey(request), answer, maxEntries);
      if (!answer.allow) return refuse(verdict, "company_rules_refused");
      if (answer.signInMaxAgeSeconds !== undefined) {
        const auth = verdict.approver.authTime === undefined ? Number.NaN : Date.parse(verdict.approver.authTime);
        if (!Number.isFinite(auth) || now() - auth > answer.signInMaxAgeSeconds * 1000 || auth - now() > SIGN_IN_SKEW_MS) return refuse(verdict, "sign_in_not_fresh");
      }
      const isRequester = request.requestedBy !== undefined && verdict.approver.provider === request.requestedBy.provider && verdict.approver.personId === request.requestedBy.personId;
      if ((answer.secondPerson || !answer.selfApproval) && isRequester) return refuse(verdict, "self_approval_not_allowed");
      // The caller counts this verdict with the requirement it was handed; it must be at least as strict as the fresh answer.
      const baseRequirement = await base.requirement(request);
      const used = handedOut.get(requestKey(request)) ?? stricterRequirement(baseRequirement, STRICTER_DEFAULT_ANSWER, request);
      if (!requirementCovers(used, stricterRequirement(baseRequirement, answer, request))) return refuse(verdict, "company_rules_changed");
      if (answer.secondPerson || !answer.selfApproval || answer.minApprovers > 1) {
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
