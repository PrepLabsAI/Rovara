// Lane P3 (items A3, review M2 and L1, L2): which methods may give which answer. ONE function, used by the decision gate and by the merge press, so the two cannot disagree.
import type { ApprovalRequirement } from "@agentx/contracts";
import { CODE_HOST_COMMENT_METHOD, LOCAL_SESSION_METHOD } from "../../ports/policy-defaults.js";

export type DecisionOutcomeName = "approve" | "reject" | "request_changes";

/** A deployer's limits on the plug-in's sets (the decision gate's policy). They may only narrow. */
export interface MethodPolicy {
  highRiskMethods?: readonly string[] | undefined;
  rejectMethods?: readonly string[] | undefined;
  changesMethods?: readonly string[] | undefined;
}

/** Whether a method proves one act by a code host comment: `code-host-comment`, any `code-host-*` method, and every method the plug-in lists in `commentMethods`. */
export function isCommentMethod(method: string, requirement: Pick<ApprovalRequirement, "commentMethods"> = {}): boolean {
  return method === CODE_HOST_COMMENT_METHOD || method.startsWith("code-host-") || requirement.commentMethods?.includes(method) === true;
}

/**
 * The methods that may give this answer, or undefined when the requirement's own `methods` are the only limit (a low or medium risk approval; a request for changes is never undefined).
 * The plug-in's names (`strongMethods`, `rejectMethods`, `changesMethods`) come first; when it names nothing the default is the local session (for changes also a comment), so a high-risk approval and a rejection need a
 * signed-in session unless the plug-in says which of its methods are one. A comment method (`isCommentMethod`) is dropped from the strong sets (high risk, reject) whatever names it. A policy that names a set
 * can only narrow the plug-in's set (their intersection); when the plug-in names none, the policy's set stands. An empty set is a set: nothing is accepted.
 */
export function strictMethodsFor(
  outcome: DecisionOutcomeName, risk: string, requirement: Pick<ApprovalRequirement, "strongMethods" | "rejectMethods" | "changesMethods" | "commentMethods">, policy: MethodPolicy = {},
): readonly string[] | undefined {
  const noComment = (methods: readonly string[]): readonly string[] => methods.filter((method) => !isCommentMethod(method, requirement));
  const narrowed = (named: readonly string[] | undefined, limit: readonly string[] | undefined, fallback: readonly string[]): readonly string[] =>
    limit === undefined ? (named ?? fallback) : named === undefined ? limit : named.filter((method) => limit.includes(method));
  if (outcome === "reject") return noComment(narrowed(requirement.rejectMethods, policy.rejectMethods, [LOCAL_SESSION_METHOD]));
  if (outcome === "request_changes") return narrowed(requirement.changesMethods, policy.changesMethods, [LOCAL_SESSION_METHOD, CODE_HOST_COMMENT_METHOD]);
  return risk === "high" ? noComment(narrowed(requirement.strongMethods, policy.highRiskMethods, [LOCAL_SESSION_METHOD])) : undefined;
}
