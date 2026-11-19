// Lane H: "may this person decide this? is the sign-in fresh enough? is a second person needed?" over the `approvers` point (approvals, Keep, sensitive
// settings: every caller of the point). Stricter only. Only a real decision asks (controller, 2026-11-15): `verify`, once per approved verdict of the install's
// own approvers. `requirement` is also read by pages and probes, so it never asks. It answers from the last signed answer for this company, project, kind,
// subject type, risk and asker while that answer is alive (its own expiry, at most 300 s); otherwise, or after a "no", the stricter default (a second person
// needed). A caller that decides on `requirement` alone therefore never decides on an answer older than the service allowed.
// `verify` enforces what one verdict can carry by itself (a "no", no answer, the sign-in age, the asker approving, the sole-approver mark) and checks the count
// the caller counts with: the smallest `minApprovers` ever handed out for this exact request (company, id, kind, subject, revision, digest), or the install's
// own count when none was (entries lapse after 10 minutes). When the fresh answer needs more, the verdict is refused (`company_rules_changed`); a new request reads the new rule.
// A claim a refused verdict holds is given back.
// A "second person needed" answer (owner row 11.5: loosening a setting needs a second admin) means: the person who asked may not approve, no sole-approver
// exception, and at least two approvers when the request names no one who asked.
import {
  type ApprovalProof, type ApprovalRequest, type ApprovalRequirement, type ApprovalSignInRule, type ApprovalVerdict, type Approvers, type PolicyHookDecideAnswer, type PolicyHookDecideQuestion, type Principal,
} from "@agentx/contracts";
import type { PolicyHookClient } from "./client.js";

/** How long the smallest count handed out for a request is held against its verdicts. */
const HANDED_OUT_LIFE_MS = 10 * 60_000;

/** A sign-in time this far ahead of the clock is not believed. */
const SIGN_IN_SKEW_MS = 30_000;

export interface PolicyHookApproversOptions {
  now?: () => number;
  /** At most this many known requirements and handed-out requirements are remembered. */
  maxEntries?: number;
}

/** The stricter default, used for a requirement before the service has answered for its kind: a second person needed. */
export const STRICTER_DEFAULT_ANSWER: PolicyHookDecideAnswer = Object.freeze({ allow: true, minApprovers: 1, secondPerson: true, selfApproval: false });

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
  /** The last signed answer, by company, project, kind, subject type, risk and asker, until the answer's own expiry. A "no" is kept as the stricter default. */
  const known = new Map<string, { answer: PolicyHookDecideAnswer; expiresAt: number }>();
  /**
   * The smallest approver count handed out for each exact request, so `verify` knows the count the caller counts with. It is never raised or cleared while it
   * lives (a caller may still hold it); it lapses 10 minutes after it was first handed out, far longer than any caller holds a requirement between reading it and
   * verifying (one request), and a lapsed or missing entry falls back to the install's own count, the loosest a caller can hold.
   */
  const handedOut = new Map<string, { count: number; since: number }>();
  const handedOutCount = (key: string): number | undefined => {
    const entry = handedOut.get(key);
    return entry !== undefined && now() - entry.since < HANDED_OUT_LIFE_MS ? entry.count : undefined;
  };
  const kindKey = (request: ApprovalRequest): string => JSON.stringify([request.companyId, request.projectName ?? "", request.kind, request.subject.type, request.risk ?? "", request.requestedBy?.provider ?? "", request.requestedBy?.personId ?? ""]);
  const requestKey = (request: ApprovalRequest): string => JSON.stringify([request.companyId, request.requestId, request.kind, request.subject.type, request.subject.id, request.revision, request.artifactDigest]);
  const knownAnswer = (request: ApprovalRequest): PolicyHookDecideAnswer => {
    const entry = known.get(kindKey(request));
    return entry !== undefined && now() < entry.expiresAt ? entry.answer : STRICTER_DEFAULT_ANSWER;
  };
  async function ask(request: ApprovalRequest, stage: "requirement" | "verdict", approver?: Principal): Promise<{ answer: PolicyHookDecideAnswer; expiresAt: number } | "unaskable" | undefined> {
    const prepared = await hook.prepare("decide", decideQuestion(request, stage, approver));
    if (prepared === undefined) return "unaskable";
    const result = await hook.send(prepared);
    await hook.audit(prepared, result.answered ? { answered: true, allow: result.answer.allow, attempts: 1 } : { answered: false, attempts: 1 });
    return result.answered ? { answer: result.answer, expiresAt: result.expiresAt } : undefined;
  }
  const refuse = async (verdict: Extract<ApprovalVerdict, { approved: true }>, reason: string): Promise<ApprovalVerdict> => {
    if (verdict.claimId !== undefined) await base.releaseClaim?.(verdict.claimId).catch(() => undefined);
    return { approved: false, reason };
  };
  const wrapped: Approvers = {
    async requirement(request) {
      // Never asks: pages and probes read this. The last known answer, or the stricter default.
      const requirement = stricterRequirement(await base.requirement(request), knownAnswer(request), request);
      // Keep the loosest count handed out for this request: a later, stricter read never hides what an earlier caller counts with.
      const key = requestKey(request);
      const held = handedOutCount(key);
      if (held === undefined) remember(handedOut, key, { count: requirement.minApprovers, since: now() }, maxEntries);
      else if (requirement.minApprovers < held) handedOut.get(key)!.count = requirement.minApprovers;
      return requirement;
    },
    async verify(request: ApprovalRequest, proof: ApprovalProof) {
      const verdict = await base.verify(request, proof);
      if (!verdict.approved) return verdict;
      // A hook that throws is no answer: the verdict is refused and any claim it holds given back (a refusal never burns a one-time proof).
      let asked: Awaited<ReturnType<typeof ask>>;
      try { asked = await ask(request, "verdict", verdict.approver); } catch { return refuse(verdict, "company_rules_no_answer"); }
      if (asked === undefined) return refuse(verdict, "company_rules_no_answer");
      if (asked === "unaskable") return refuse(verdict, "company_rules_refused");
      const answer = asked.answer;
      // Every signed answer is the last known one for this kind until it expires; a "no" is kept as the stricter default, never as permission.
      remember(known, kindKey(request), { answer: answer.allow ? answer : STRICTER_DEFAULT_ANSWER, expiresAt: asked.expiresAt }, maxEntries);
      if (!answer.allow) return refuse(verdict, "company_rules_refused");
      if (answer.signInMaxAgeSeconds !== undefined) {
        const auth = verdict.approver.authTime === undefined ? Number.NaN : Date.parse(verdict.approver.authTime);
        if (!Number.isFinite(auth) || now() - auth > answer.signInMaxAgeSeconds * 1000 || auth - now() > SIGN_IN_SKEW_MS) return refuse(verdict, "sign_in_not_fresh");
      }
      const isRequester = request.requestedBy !== undefined && verdict.approver.provider === request.requestedBy.provider && verdict.approver.personId === request.requestedBy.personId;
      if ((answer.secondPerson || !answer.selfApproval) && isRequester) return refuse(verdict, "self_approval_not_allowed");
      // The count the caller counts with must be at least the fresh answer's. A caller that never read the requirement through here counts with the install's own.
      let baseRequirement: ApprovalRequirement;
      try {
        baseRequirement = await base.requirement(request);
      } catch {
        return refuse(verdict, "company_rules_refused");
      }
      const key = requestKey(request);
      const usedCount = handedOutCount(key) ?? baseRequirement.minApprovers;
      // The entry is kept as it is: another caller may still count with it. A new request (a new id or revision) reads the new rule.
      if (stricterRequirement(baseRequirement, answer, request).minApprovers > usedCount) return refuse(verdict, "company_rules_changed");
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
