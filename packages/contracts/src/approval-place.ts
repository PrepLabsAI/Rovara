// Approval-place policy (owner decisions 62, 66, 83; requirements A-01, A-02, A-08, A-09, A-49, E-37, E-38): ONE pure function that says whether a person's answer to a decision may be taken from the place it came from, so
// every surface (the app, a chat, a tracker or code-host comment, an AI tool or token) asks the same question and cannot invent its own rule. Nothing in it reads a store, a clock or a provider: the caller passes what it
// verified (who the person is, their role, when they last signed in to Rovara interactively) and the answer is a verdict with the things the person could still do (`needs`).
//
// The rules, in the order they are checked:
//   1. Anything the function cannot read is refused (`invalid_input`).
//   2. "Not now" is a dismissal of the card for that person, never a decision, from every place (A-49). It is never `allowed`.
//   3. Outside places (a chat, a tracker comment, a code-host comment) need a LINKED person: the outside account maps to a Rovara person of this company. An unlinked one is told to link (`not_linked`).
//   4. Who may decide (E-37, decisions 14, 36): the task owner and co-owners; maintainers, for plans, designs and product decisions of any risk and for merges; a collaborator
//      only a LOW-risk PRODUCT decision, and only while the project allows it, never a coding plan, a design or a merge. Contributors who do not own the task, viewers and strangers decide nothing. When someone other
//      than the owner decides, `notifyOwner` is true. (A merge's own approvers, CODEOWNERS and the rest, stay with the merge rules; this only keeps a collaborator or a stranger out of one.)
//   5. Where it may be answered, by answer and risk:
//        approve  low     browser, tool, or an outside place by a linked person;
//        approve  medium  browser; or an outside place by a linked person whose last INTERACTIVE Rovara sign-in is inside the company's window (default 24 h, 1 h to 7 days); a tool (an AI tool, the CLI or an API token) gets a link;
//        approve  high    browser only, and only under the company's fresh sign-in (`freshSignIn`, decided by the caller with the rule it has: Code's `checkApprovalSignIn`, or an extra sign-in step an approvers plug-in asks for);
//        reject   any     browser only (a signed-in session), under the fresh sign-in;
//        request changes  any place a linked person can reach; no sign-in age.
// The "recent" time is the person's last interactive Rovara sign-in (`Principal.authTime`, the adapter's own fact), never a refresh and never a sign-in at the outside service (decision Q3); a caller that cannot say passes none and the
// answer is "sign in again". The window is a COMPANY SETTING: shortening applies at once; lengthening needs a second admin's confirmation (decision 83), which `checkRecentSignInChange` reports and the store enforces.
//
// Pure and browser-safe, so a page can show "Open in Rovara" from the same verdict the server enforces.
import { z } from "zod";

/** A sign-in time this far ahead of the clock is not believed (clock skew between machines). The same number as `APPROVAL_SIGN_IN_SKEW_SECONDS`; this file stands alone so a copy of it can sit beside code that has no other file of Code's (a test keeps the two equal). */
export const RECENT_SIGN_IN_SKEW_SECONDS = 120;

// ---- The recent sign-in window (a company setting) ----

export const RECENT_SIGN_IN_DEFAULT_SECONDS = 86_400;
export const RECENT_SIGN_IN_MIN_SECONDS = 3_600;
export const RECENT_SIGN_IN_MAX_SECONDS = 604_800;

export const RecentSignInSettingSchema = z.object({ seconds: z.number().int().min(RECENT_SIGN_IN_MIN_SECONDS).max(RECENT_SIGN_IN_MAX_SECONDS) }).strict();
export type RecentSignInSetting = z.infer<typeof RecentSignInSettingSchema>;

/** What a company has when it chose nothing: 24 hours. */
export const DEFAULT_RECENT_SIGN_IN_SETTING: RecentSignInSetting = { seconds: RECENT_SIGN_IN_DEFAULT_SECONDS };

export type RecentSignInChangeKind = "same" | "shorten" | "lengthen";
export type RecentSignInChangeCheck =
  | { ok: true; setting: RecentSignInSetting; change: RecentSignInChangeKind; needsSecondAdmin: boolean }
  | { ok: false; reason: "invalid" };

/**
 * Whether a company may move its window from `current` to `proposed`, and what that takes. A value outside 1 hour to 7 days, a fraction, or an unknown field is `invalid`. Shortening (and the same value) takes effect at once;
 * lengthening is the less-safe direction and needs a second admin to confirm (decision 83). `current` is read the way the store reads it: anything unreadable is the default window, so a damaged row cannot be used to
 * lengthen without a second admin.
 */
export function checkRecentSignInChange(current: unknown, proposed: unknown): RecentSignInChangeCheck {
  const next = RecentSignInSettingSchema.safeParse(proposed);
  if (!next.success) return { ok: false, reason: "invalid" };
  const before = RecentSignInSettingSchema.safeParse(current);
  const from = before.success ? before.data.seconds : RECENT_SIGN_IN_DEFAULT_SECONDS;
  const change: RecentSignInChangeKind = next.data.seconds === from ? "same" : next.data.seconds < from ? "shorten" : "lengthen";
  return { ok: true, setting: next.data, change, needsSecondAdmin: change === "lengthen" };
}

// ---- The policy ----

export const APPROVAL_PLACE_RISKS = ["low", "medium", "high"] as const;
export type ApprovalPlaceRisk = (typeof APPROVAL_PLACE_RISKS)[number];

/** `not_now` is a chat's one-tap dismissal. It is listed so a surface can ask about it and be told it is never a decision. */
export const APPROVAL_PLACE_ANSWERS = ["approve", "request_changes", "reject", "not_now"] as const;
export type ApprovalPlaceAnswer = (typeof APPROVAL_PLACE_ANSWERS)[number];

/** Where the answer came from. `browser`: a live signed-in browser session. `chat`: a press or a reply in a chat. `tracker-comment` and `code-host-comment`: a comment command. `tool`: an AI tool (MCP), the CLI or an API token. */
export const APPROVAL_PLACES = ["browser", "chat", "tracker-comment", "code-host-comment", "tool"] as const;
export type ApprovalPlace = (typeof APPROVAL_PLACES)[number];

/** What is being decided. `plan` is a coding plan, `design` a design, `product` a low-risk product-level question (decision 36), `merge` a merge (whose own rules stay in the merge). */
export const APPROVAL_DECISION_KINDS = ["plan", "design", "product", "merge"] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISION_KINDS)[number];

/** The decider's standing on the task and its project. `owner` covers the task's owner and `co-owner` its co-owners. `none` is anyone else. */
export const APPROVAL_DECIDER_ROLES = ["owner", "co-owner", "maintainer", "contributor", "collaborator", "viewer", "none"] as const;
export type ApprovalDeciderRole = (typeof APPROVAL_DECIDER_ROLES)[number];

export interface ApprovalPlaceInput {
  kind: ApprovalDecisionKind;
  risk: ApprovalPlaceRisk;
  answer: ApprovalPlaceAnswer;
  place: ApprovalPlace;
  decider: {
    role: ApprovalDeciderRole;
    /** Outside places only: the outside account maps to a Rovara person of this company. For `browser` and `tool` the authenticated session or token is the link and this is not read. */
    linked: boolean;
    /** The person's last interactive Rovara sign-in (ISO time), when the identity adapter knows. Read for a medium approval from an outside place. */
    authTime?: string | undefined;
  };
  settings: {
    /** The company's window. Read only for a medium approval from an outside place. */
    recentSignIn: RecentSignInSetting;
    /** The project's switch for collaborators' low-risk product approvals (default on). */
    collaboratorApprovals: boolean;
  };
  /**
   * A high-risk approval and every rejection also need the company's fresh sign-in step (decision 62). The caller decides it with its own rule and passes the result; true only when this person satisfied it for this
   * decision just now.
   */
  freshSignIn: boolean;
  nowMs: number;
}

export type ApprovalPlaceReason =
  | "ok"
  | "dismissal"
  | "invalid_input"
  | "invalid_setting"
  | "not_linked"
  | "role_not_allowed"
  | "collaborator_approvals_off"
  | "high_risk_browser_only"
  | "reject_browser_only"
  | "tool_low_risk_only"
  | "fresh_sign_in_required"
  | "no_sign_in_time"
  | "sign_in_too_old"
  | "sign_in_in_future";

/** What the person could still do. A surface turns these into its own words ("Open in Rovara", a link prompt). */
export type ApprovalPlaceNeed = "link_account" | "sign_in_recently" | "open_in_rovara" | "fresh_sign_in" | "ask_maintainer";

export interface ApprovalPlaceVerdict {
  /** True only when this answer may be recorded as the person's decision from this place. */
  allowed: boolean;
  reason: ApprovalPlaceReason;
  /** Everything unmet that the person could fix, in the order to do it. Empty when allowed, and for a dismissal. */
  needs: readonly ApprovalPlaceNeed[];
  /** `dismissal`: hide the card for this person and decide nothing (never a rejection). `decision`: record it. `refused`: do neither. */
  effect: "decision" | "dismissal" | "refused";
  /** True when the decider is not the task's owner or a co-owner: tell the owner who decided (decision 36, Q7). */
  notifyOwner: boolean;
}

const refused = (reason: ApprovalPlaceReason, needs: readonly ApprovalPlaceNeed[] = []): ApprovalPlaceVerdict => ({ allowed: false, reason, needs, effect: "refused", notifyOwner: false });
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

const OUTSIDE_PLACES: readonly ApprovalPlace[] = ["chat", "tracker-comment", "code-host-comment"];
export const isOutsideApprovalPlace = (place: ApprovalPlace): boolean => OUTSIDE_PLACES.includes(place);

/** Who may decide this kind at this risk, apart from where they answer. `undefined`: allowed. */
function roleVerdict(input: ApprovalPlaceInput): ApprovalPlaceVerdict | undefined {
  const { role } = input.decider;
  if (role === "owner" || role === "co-owner") return undefined;
  if (role === "maintainer") return undefined;
  // Everyone else would have to ask someone who may; only a collaborator on an allowed product decision, below, gets through.
  if (role === "collaborator") {
    if (input.kind !== "product" || input.risk !== "low") return refused("role_not_allowed", ["ask_maintainer"]);
    return input.settings.collaboratorApprovals === true ? undefined : refused("collaborator_approvals_off", ["ask_maintainer"]);
  }
  return refused("role_not_allowed", ["ask_maintainer"]);
}

/**
 * Whether this answer may be taken from this place. See the file header for the rules. Never throws: anything it cannot read is refused, and `allowed` is true only on the paths below that say so.
 */
export function approvalPlaceDecision(input: ApprovalPlaceInput): ApprovalPlaceVerdict {
  const i = input as Partial<ApprovalPlaceInput> | null | undefined;
  if (i === null || typeof i !== "object" || i.decider === null || typeof i.decider !== "object" || i.settings === null || typeof i.settings !== "object"
    || !isOneOf(APPROVAL_DECISION_KINDS, i.kind) || !isOneOf(APPROVAL_PLACE_RISKS, i.risk) || !isOneOf(APPROVAL_PLACE_ANSWERS, i.answer) || !isOneOf(APPROVAL_PLACES, i.place)
    || !isOneOf(APPROVAL_DECIDER_ROLES, i.decider.role) || typeof i.freshSignIn !== "boolean" || typeof i.nowMs !== "number" || !Number.isFinite(i.nowMs)) {
    return refused("invalid_input");
  }
  const { answer, place, risk, decider } = input;
  // A dismissal decides nothing, so no sign-in age, link or role matters to it, and it can never be turned into a decision.
  if (answer === "not_now") return { allowed: false, reason: "dismissal", needs: [], effect: "dismissal", notifyOwner: false };

  const outside = isOutsideApprovalPlace(place);
  if (outside && decider.linked !== true) return refused("not_linked", ["link_account"]);

  const role = roleVerdict(input);
  if (role !== undefined) return role;

  const notifyOwner = decider.role !== "owner" && decider.role !== "co-owner";
  const allowed: ApprovalPlaceVerdict = { allowed: true, reason: "ok", needs: [], effect: "decision", notifyOwner };

  if (answer === "request_changes") return allowed;

  if (answer === "reject") {
    const needs: ApprovalPlaceNeed[] = [];
    if (place !== "browser") needs.push("open_in_rovara");
    if (!input.freshSignIn) needs.push("fresh_sign_in");
    if (place !== "browser") return refused("reject_browser_only", needs);
    return input.freshSignIn ? allowed : refused("fresh_sign_in_required", needs);
  }

  // answer === "approve"
  if (risk === "high") {
    const needs: ApprovalPlaceNeed[] = [];
    if (place !== "browser") needs.push("open_in_rovara");
    if (!input.freshSignIn) needs.push("fresh_sign_in");
    if (place !== "browser") return refused("high_risk_browser_only", needs);
    return input.freshSignIn ? allowed : refused("fresh_sign_in_required", needs);
  }
  if (risk === "low" || place === "browser") return allowed;
  if (place === "tool") return refused("tool_low_risk_only", ["open_in_rovara"]);

  // A medium approval from an outside place: a linked person with a recent interactive Rovara sign-in.
  const window = RecentSignInSettingSchema.safeParse(input.settings.recentSignIn);
  if (!window.success) return refused("invalid_setting", ["open_in_rovara"]);
  const signedIn = typeof decider.authTime === "string" ? Date.parse(decider.authTime) : Number.NaN;
  if (!Number.isFinite(signedIn)) return refused("no_sign_in_time", ["sign_in_recently"]);
  if (signedIn > input.nowMs + RECENT_SIGN_IN_SKEW_SECONDS * 1000) return refused("sign_in_in_future", ["sign_in_recently"]);
  if (input.nowMs - signedIn > window.data.seconds * 1000) return refused("sign_in_too_old", ["sign_in_recently"]);
  return allowed;
}
