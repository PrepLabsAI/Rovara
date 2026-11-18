// Nightly upkeep (lead 4 N1, DEC 254z(2), DEC 254zza; design setup-upkeep-plan.md 2.2): one switch and one monthly dollar cap per project, off by default. This file is the words and shapes Code
// shares with Cloud's model gateway (the contract for callers in Cloud's docs/model-gateway-spend-limits.md, L4-E):
//
//   - the work origin of upkeep AI is the TC-1 claim `src: "nightly"` (`UPKEEP_ORIGIN`), minted ONLY for upkeep AI calls (a wiki refresh the nightly job started). Nothing else Code starts carries it with a model key.
//   - a refused upkeep call is HTTP 422 `upkeep_paused` with the header `x-rovara-upkeep-pause` = one of `UPKEEP_PAUSE_REASONS`; its message is one of the fixed sentences below (the gateway's `UPKEEP_PAUSE_MESSAGES`).
//   - the admins' notice is Code's: one attention event per company, project, month and reason (`upkeepNoticeId`), kind `upkeep_paused`, in fixed words.
import { z } from "zod";
import { AGENTX_NAME_PATTERN } from "./names.js";

/** The TC-1 `src` claim that marks nightly upkeep AI (Cloud: model-gateway-token.ts WORK_ORIGINS, upkeep-cap.ts UPKEEP_ORIGIN). */
export const UPKEEP_ORIGIN = "nightly" as const;
/** The scheduler target kind of a project's upkeep night (the nightly TEST run has its own, `nightly`). */
export const UPKEEP_TARGET_KIND = "upkeep" as const;
/** The default upkeep cap, shown by the setup page; the gateway holds the real number. */
export const UPKEEP_DEFAULT_MONTH_USD = 25;
/** The header the gateway names the pause reason in. */
export const UPKEEP_PAUSE_HEADER = "x-rovara-upkeep-pause" as const;

export const UPKEEP_PAUSE_REASONS = ["no_budget", "monthly_limit", "cost_too_high"] as const;
export const UpkeepPauseReasonSchema = z.enum(UPKEEP_PAUSE_REASONS);
export type UpkeepPauseReason = z.infer<typeof UpkeepPauseReasonSchema>;

/** The gateway's fixed sentences (Cloud `UPKEEP_PAUSE_MESSAGES`). A refused call's text is matched against these, never parsed. */
export const UPKEEP_PAUSE_MESSAGES: Readonly<Record<UpkeepPauseReason, string>> = Object.freeze({
  no_budget: "Nightly upkeep has no spending limit for this project, so it is paused.",
  monthly_limit: "This project's monthly nightly upkeep limit is used up, so upkeep is paused until next month.",
  cost_too_high: "One upkeep call of this size cannot fit this project's monthly upkeep limit.",
});

/** The pause a refused call names, read from its fixed sentence (a worker only has the provider's text). Anything else is not a pause. */
export function upkeepPauseReasonOfText(text: unknown): UpkeepPauseReason | undefined {
  if (typeof text !== "string") return undefined;
  return UPKEEP_PAUSE_REASONS.find((reason) => text.includes(UPKEEP_PAUSE_MESSAGES[reason]));
}

/** The pause a gateway answer names: 422, error type `upkeep_paused` and a header that is one of the reasons. A 503 (an unreadable limit) and every other answer is not a pause. */
export function upkeepPauseReasonOfAnswer(answer: { status: number; code?: unknown; header?: unknown }): UpkeepPauseReason | undefined {
  if (answer.status !== 422 || answer.code !== "upkeep_paused") return undefined;
  const parsed = UpkeepPauseReasonSchema.safeParse(answer.header);
  return parsed.success ? parsed.data : undefined;
}

/** What the admins' notice says (the line under the project's name). Fixed words; the project name is the only variable and goes through `oneLine` where it is shown. */
export const UPKEEP_NOTICE_WORDS: Readonly<Record<UpkeepPauseReason, string>> = Object.freeze({
  no_budget: "Nightly upkeep is paused: no spending limit is set for it. Set one on Spending limits.",
  monthly_limit: "Nightly upkeep is paused: this month's upkeep limit is used up. Raise it on Spending limits, or it resumes next month.",
  cost_too_high: "Nightly upkeep is paused: one refresh is larger than the monthly upkeep limit. Raise it on Spending limits.",
});

/** The UTC month an upkeep pause is deduped by, `YYYY-MM`. */
export const UpkeepMonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u);
export const upkeepMonthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** The identity of one admins' notice: company, project, month and reason. Two pauses with the same identity are one notice. */
export function upkeepNoticeId(parts: { orgId: string; project: string; month: string; reason: UpkeepPauseReason }): string {
  if (!AGENTX_NAME_PATTERN.test(parts.project) || !UpkeepMonthSchema.safeParse(parts.month).success || !UpkeepPauseReasonSchema.safeParse(parts.reason).success) throw new Error("not an upkeep notice identity");
  return `${parts.orgId}#${parts.project}#${parts.month}#${parts.reason}`;
}

/** The pending row's subject id for an upkeep notice (the place a session id has on a task's row): `upkeep-<month>-<reason>-<project>`, which no session id looks like. */
export const upkeepSubjectId = (parts: { project: string; month: string; reason: UpkeepPauseReason }): string => {
  if (!AGENTX_NAME_PATTERN.test(parts.project) || !UpkeepMonthSchema.safeParse(parts.month).success || !UpkeepPauseReasonSchema.safeParse(parts.reason).success) throw new Error("not an upkeep subject");
  return `upkeep-${parts.month}-${parts.reason}-${parts.project}`;
};
const SUBJECT = /^upkeep-(\d{4}-(?:0[1-9]|1[0-2]))-(no_budget|monthly_limit|cost_too_high)-(.+)$/u;
/** The parts of an upkeep subject id, or undefined when it is not one (a session id is never read as one). */
export function upkeepSubjectOf(subjectId: string): { month: string; reason: UpkeepPauseReason; project: string } | undefined {
  const match = SUBJECT.exec(subjectId);
  if (match === null || !AGENTX_NAME_PATTERN.test(match[3]!)) return undefined;
  return { month: match[1]!, reason: match[2] as UpkeepPauseReason, project: match[3]! };
}

/** Where a night ended (the audit and the setup page's one line). Fixed words, never repository text. */
export const UPKEEP_NIGHT_OUTCOMES = ["off", "nothing_changed", "ran", "paused", "no_cost_cap", "needs_ai_key", "busy", "failed"] as const;
export type UpkeepNightOutcome = (typeof UPKEEP_NIGHT_OUTCOMES)[number];

// ---- The switch's routes (the contract the Cloud setup panel reads) ------------------------------------------------------------------------------------------------------------------

/** The route, under a project. Hosted and laptop serve the same path and answers. GET: any role on the project reads. PUT: a live company owner or admin, or the project's administrator, switches it. */
export const UPKEEP_ROUTE = { method: "GET and PUT", path: "/v1/app/projects/{project}/upkeep" } as const;
/** The switch's body: strict, a request id (one act per id AND choice) and the choice. Nothing else can come from a client (the cap lives in the gateway, never in this body). */
export const UpkeepSwitchBodySchema = z.object({ requestId: z.string().uuid(), on: z.boolean() }).strict();
export type UpkeepSwitchBody = z.infer<typeof UpkeepSwitchBodySchema>;
/** What GET and PUT answer: whether upkeep is ON (off by default), whether the caller may change it, and whether this install can run nightly upkeep at all. */
export const UpkeepViewSchema = z.object({ enabled: z.boolean(), canManage: z.boolean(), /** Whether nightly runs really happen on this install. False: the page hides the switch and a change is refused in fixed words. */ available: z.boolean() }).strict();
export type UpkeepView = z.infer<typeof UpkeepViewSchema>;
