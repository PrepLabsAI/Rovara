// Lane P3, item A1 and owner decision 62: how recent an approver's sign-in must be is a COMPANY SETTING. Two choices: a window (default ten minutes, `FRESH_SIGN_IN_SECONDS`), or "trust any active company sign-in", which only a
// company on its own single sign-on may choose (its identity provider already asks for a fresh proof, so a high-risk approval needs no extra step). Code ignores the sign-in time (the local owner has none and the
// approvers default sets no rule); an approvers plug-in puts the company's choice into `ApprovalRequirement.signIn`, and the decision gate and the merge press then enforce it for high-risk approvals and rejections.
//
// Pure and browser-safe: the setting's shape, its validation, and the one check. The stored copy and its edit are in the broker (`core/decisions/sign-in-setting.ts`).
import { z } from "zod";
import { FRESH_SIGN_IN_SECONDS } from "./developer.js";
import type { ApprovalAnswer, ApprovalRequirement, ApprovalRisk, ApprovalSignInRule, Principal } from "./ports/policy.js";

export const APPROVAL_SIGN_IN_WINDOW_MIN_SECONDS = 60;
export const APPROVAL_SIGN_IN_WINDOW_MAX_SECONDS = 86_400;
/** A sign-in time this far ahead of the clock is not believed (clock skew between machines). */
export const APPROVAL_SIGN_IN_SKEW_SECONDS = 120;

export const ApprovalSignInSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("window"), seconds: z.number().int().min(APPROVAL_SIGN_IN_WINDOW_MIN_SECONDS).max(APPROVAL_SIGN_IN_WINDOW_MAX_SECONDS) }).strict(),
  z.object({ mode: z.literal("any-active") }).strict(),
]);
export type ApprovalSignInSetting = z.infer<typeof ApprovalSignInSettingSchema>;

type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const APPROVAL_SIGN_IN_SHAPES_MATCH: SameShape<ApprovalSignInSetting, ApprovalSignInRule> = true;

/** What a company has when it chose nothing: the ten minute window. */
export const DEFAULT_APPROVAL_SIGN_IN_SETTING: ApprovalSignInSetting = { mode: "window", seconds: FRESH_SIGN_IN_SECONDS };

export type ApprovalSignInSettingCheck = { ok: true; setting: ApprovalSignInSetting } | { ok: false; reason: "invalid" | "needs_company_sign_in" };

/**
 * Whether a company may save this setting. "Trust any active company sign-in" needs `companyOwnSignIn`: the identity adapter signs people in through the company's own single sign-on (`IdentityCapabilities.companySignIn`).
 * Without it the choice is refused, so a company on a shared or local sign-in cannot switch the extra step off.
 */
export function checkApprovalSignInSetting(input: unknown, context: { companyOwnSignIn: boolean }): ApprovalSignInSettingCheck {
  const parsed = ApprovalSignInSettingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.mode === "any-active" && !context.companyOwnSignIn) return { ok: false, reason: "needs_company_sign_in" };
  return { ok: true, setting: parsed.data };
}

export type ApprovalSignInVerdict = { ok: true } | { ok: false; reason: "invalid_rule" | "no_company_sign_in" | "no_sign_in_time" | "sign_in_too_old" | "sign_in_in_future" };

/**
 * Whether an approver's sign-in satisfies a rule. The rule is checked first (a plug-in's rule is data): seconds must be a whole number within the limits, else the answer is `invalid_rule`.
 * Every mode needs a readable sign-in time that is not in the future: it is the proof that an interactive sign-in exists. A window fails closed on a missing, unreadable or future time, and on one older than the window.
 * `any-active` (decision 62: trust any active company sign-in) also needs `context.companySignIn`, the identity adapter's own `capabilities.companySignIn`, read by the caller from the adapter and never from a request; without it
 * the answer is `no_company_sign_in`, so a plug-in cannot switch freshness off for a company that has no sign-in of its own.
 */
export function checkApprovalSignIn(rule: ApprovalSignInRule, approver: Pick<Principal, "authTime">, nowMs: number, context: { companySignIn: boolean }): ApprovalSignInVerdict {
  const parsed = ApprovalSignInSettingSchema.safeParse(rule);
  if (!parsed.success) return { ok: false, reason: "invalid_rule" };
  const checked = parsed.data;
  if (checked.mode === "any-active" && !context.companySignIn) return { ok: false, reason: "no_company_sign_in" };
  if (approver.authTime === undefined) return { ok: false, reason: "no_sign_in_time" };
  const signedIn = Date.parse(approver.authTime);
  if (!Number.isFinite(signedIn)) return { ok: false, reason: "no_sign_in_time" };
  if (signedIn > nowMs + APPROVAL_SIGN_IN_SKEW_SECONDS * 1000) return { ok: false, reason: "sign_in_in_future" };
  if (checked.mode === "any-active") return { ok: true };
  return nowMs - signedIn <= checked.seconds * 1000 ? { ok: true } : { ok: false, reason: "sign_in_too_old" };
}

// ---- Owner decision 211, gap G1: sign-in rules for some answers, risks and methods ----

const ANSWERS = ["approve", "reject", "request_changes"] as const;
const RISKS = ["low", "medium", "high"] as const;

/** A scoped rule as a plug-in may state it (`ApprovalRequirement.signInRules`). Empty lists are refused: "no method" is not a way to say "every method". */
export const ApprovalSignInScopeSchema = z.object({
  outcomes: z.array(z.enum(ANSWERS)).min(1).max(ANSWERS.length),
  risks: z.array(z.enum(RISKS)).min(1).max(RISKS.length).optional(),
  methods: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
  rule: ApprovalSignInSettingSchema,
}).strict();
const ApprovalSignInScopesSchema = z.array(ApprovalSignInScopeSchema).max(50);

/** One answer, as the rules are matched against it. A risk that is not one of the three names (absent, `critical`, `HIGH`) counts as high, and an outcome that is not one of the three as a rejection (fail closed). */
export interface ApprovalSignInAt {
  outcome: ApprovalAnswer;
  risk: ApprovalRisk | undefined;
  method: string;
}

export type ApprovalSignInRules = { ok: true; rules: ApprovalSignInRule[] } | { ok: false; reason: "invalid_rule" };

/**
 * The sign-in rules that apply to one answer: `signIn` for a high-risk approval and for every rejection (its meaning before decision 211, unchanged), then each scoped rule whose answers, risks and methods all
 * cover this one. A plug-in's rules are data: when any scoped rule cannot be read the answer is `invalid_rule`, whatever answer it was about, and the caller refuses. Rules only ever add.
 */
export function signInRulesFor(requirement: Pick<ApprovalRequirement, "signIn" | "signInRules">, at: ApprovalSignInAt): ApprovalSignInRules {
  const risk: ApprovalRisk = at.risk !== undefined && RISKS.includes(at.risk) ? at.risk : "high";
  const outcome: ApprovalAnswer = ANSWERS.includes(at.outcome) ? at.outcome : "reject";
  const rules: ApprovalSignInRule[] = [];
  if (requirement.signIn !== undefined && (outcome === "reject" || (outcome === "approve" && risk === "high"))) rules.push(requirement.signIn);
  if (requirement.signInRules === undefined) return { ok: true, rules };
  const scopes = ApprovalSignInScopesSchema.safeParse(requirement.signInRules);
  if (!scopes.success) return { ok: false, reason: "invalid_rule" };
  for (const scope of scopes.data) {
    if (!scope.outcomes.includes(outcome)) continue;
    if (scope.risks !== undefined && !scope.risks.includes(risk)) continue;
    if (scope.methods !== undefined && !scope.methods.includes(at.method)) continue;
    rules.push(scope.rule);
  }
  return { ok: true, rules };
}

/** Whether an approver's sign-in satisfies EVERY rule that applies to this answer (`signInRulesFor`, then `checkApprovalSignIn` for each). The first rule that fails gives the reason. */
export function checkApprovalSignInFor(
  requirement: Pick<ApprovalRequirement, "signIn" | "signInRules">, at: ApprovalSignInAt, approver: Pick<Principal, "authTime">, nowMs: number, context: { companySignIn: boolean },
): ApprovalSignInVerdict {
  const applying = signInRulesFor(requirement, at);
  if (!applying.ok) return applying;
  for (const rule of applying.rules) {
    const verdict = checkApprovalSignIn(rule, approver, nowMs, context);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
