// Nightly upkeep (lead 4 N1, DEC 254z(2), DEC 254zza; design setup-upkeep-plan.md 2.2): one switch and one monthly dollar cap per project, off by default. This file is the words and shapes Code
// shares with Cloud's model gateway (the contract for callers in Cloud's docs/model-gateway-spend-limits.md, L4-E):
//
//   - the work origin of upkeep AI is the TC-1 claim `src: "nightly"` (`UPKEEP_ORIGIN`), minted ONLY for upkeep AI calls (a wiki refresh the nightly job started). Nothing else Code starts carries it with a model key.
//   - a refused upkeep call is HTTP 422 `upkeep_paused` with the header `x-rovara-upkeep-pause` = one of `UPKEEP_PAUSE_REASONS`; its message is one of the fixed sentences below (the gateway's `UPKEEP_PAUSE_MESSAGES`).
//   - the admins' notice is Code's: one attention event per company, project, month and reason (`upkeepNoticeId`), kind `upkeep_paused`, in fixed words.
import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { AGENTX_NAME_PATTERN } from "./names.js";

/** The TC-1 `src` claim that marks nightly upkeep AI (Cloud: model-gateway-token.ts WORK_ORIGINS, upkeep-cap.ts UPKEEP_ORIGIN). */
export const UPKEEP_ORIGIN = "nightly" as const;
/** The scheduler target kind of a project's upkeep night (the nightly TEST run has its own, `nightly`). */
export const UPKEEP_TARGET_KIND = "upkeep" as const;
/** The default upkeep cap, shown by the setup page; the gateway holds the real number. */
export const UPKEEP_DEFAULT_MONTH_USD = 25;
/**
 * L4-SR1 (nightly wiki refresh): the gateway's cap READ. Code never starts nightly AI on a guess that the upkeep cap is enforced: it starts only while the gateway itself says so for THIS company, project and month.
 * A service read, the same family as the offered-models read (broker `offered-models-http.ts`): `GET <gateway>/v1/service/companies/<company>/upkeep/<project>` with a service token (aud `UPKEEP_CAP_AUDIENCE`),
 * answering `UpkeepCapReadSchema`. Anything else (no route, 404, a bad answer, a late one, another month or project) is "not known", and nothing is started.
 */
export const UPKEEP_CAP_AUDIENCE = "rovara-model-gateway-upkeep-cap" as const;
/** What the gateway says of one project's nightly upkeep cap (`company` echoes the company the token named: Code refuses an answer for another): `enforced` is always true (a gateway that does not hold the cap does not answer); `limitMicros` is the effective `upkeep_month` limit (the default when none was set, 0 = no upkeep spend); `spentMicros` is what finished upkeep calls cost this month. */
export const UpkeepCapReadSchema = z.object({
  version: z.literal(1), company: OrgIdSchema, project: z.string().regex(AGENTX_NAME_PATTERN), month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u), enforced: z.literal(true),
  limitMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), spentMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type UpkeepCapRead = z.infer<typeof UpkeepCapReadSchema>;

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
/**
 * L4-P2 (owner DEC 254zzt, option A "two locks"). Rovara's automatic runs (the free re-check at task start, the nightly check, and in P2 the AI kinds) need BOTH:
 *   1. the operator's CEILING: the stack parameter `CoreSystemRuns` covers the company (an install decision, never a customer's); and
 *   2. the company's own CONSENT: a stored, audited row written only by a LIVE company owner or admin.
 * Effective system runs = ceiling AND consent. The ceiling alone never runs anything and the consent alone never overrides the ceiling.
 * The project's upkeep switch is a third, narrower choice (maintainers may toggle it); it is only meaningful while system runs are effective.
 */
export const SYSTEM_RUNS_CONSENT_AUDIT = "system_runs.consent_set" as const;
/** Fixed words of the consent step (nothing a caller sent is echoed). */
export const SYSTEM_RUNS_CONSENT_WORDS = {
  notAllowed: "Only company owners and admins can allow or stop Rovara's automatic runs for the company.",
  needsConsent: "A company owner or admin has to allow Rovara's automatic runs for the company first.",
  contradiction: "Rovara's automatic runs cannot be stopped and nightly upkeep switched on in the same step.",
  // L4-P3 (owner 2026-11-17): ALLOWING them needs a fresh step-up (the script token's pattern: a long-lived grant is never made by a tool that holds an API token). Stopping them never does.
  needsSignIn: "Rovara's automatic runs are allowed right after you confirm it's you on the sign-in page: a tool that holds an API token cannot allow them. Confirm it's you, then try again within a few minutes.",
} as const;

/**
 * The switch's body: strict, a request id (one act per id AND choice) and the choice. Nothing else can come from a client (the cap lives in the gateway, never in this body).
 * `allowSystemRuns` (optional) is the SETUP step: a live company owner or admin sets the company's consent AND the project's switch (`on`) in ONE transaction, with an audit record for each. Absent: only the project's
 * switch changes (a maintainer may), and turning it ON needs the company's consent already given. `allowSystemRuns: false` with `on: true` is refused.
 */
export const UpkeepSwitchBodySchema = z.object({ requestId: z.string().uuid(), on: z.boolean(), allowSystemRuns: z.boolean().optional() }).strict()
  .refine((body) => !(body.allowSystemRuns === false && body.on === true), { message: "the request is not valid" });
export type UpkeepSwitchBody = z.infer<typeof UpkeepSwitchBodySchema>;
/**
 * The monthly upkeep cap as the page shows it. `monthlyUsd` is read from the gateway's limit when the host has a read for it; where it has none it is `null` (never a guess, never a number stored in Code; the
 * page then shows "set on Spending limits"). `canRaise` is true only for a live company owner or admin.
 */
export const UpkeepCapSchema = z.object({ monthlyUsd: z.number().nonnegative().nullable(), canRaise: z.boolean() }).strict();
export type UpkeepCap = z.infer<typeof UpkeepCapSchema>;
/**
 * L4-SR1: what nightly upkeep spent on this project this UTC month, for the page's "Nightly upkeep: $X of $Y" line ($Y is `cap.monthlyUsd`). Only people who manage the project get it (as the cap). It is built from
 * the settled cost of each finished nightly run, as the install's own cost ledger booked it: `spentUsd` counts the runs whose cost is KNOWN; a run whose cost is not known (no price, another currency, no usage
 * booked) is counted in `unknownRuns` and adds nothing, so when `unknownRuns` is more than 0 `spentUsd` is a floor ("at least"), never a made-up number and never a quiet zero.
 */
export const UpkeepSpendSchema = z.object({ month: UpkeepMonthSchema, spentUsd: z.number().nonnegative(), runs: z.number().int().nonnegative(), unknownRuns: z.number().int().nonnegative() }).strict();
export type UpkeepSpend = z.infer<typeof UpkeepSpendSchema>;
/**
 * What GET and PUT answer.
 *   enabled              the PROJECT's switch (off by default).
 *   canManage            the caller may change the project's switch: a live company owner or admin, or the project's administrator.
 *   available            the operator CEILING covers this company, so nightly runs can happen here. False: the page says "Nightly upkeep isn't available on this Rovara yet" and a change is refused.
 *   systemRunsOn         EFFECTIVE system runs: the ceiling AND the company's consent (what actually runs now).
 *   canEnableSystemRuns  the caller may set the company's consent (a live company owner or admin) and the ceiling is on (there is something to consent to).
 *   cap                  see `UpkeepCapSchema`.
 */
export const UpkeepViewSchema = z.object({
  enabled: z.boolean(), canManage: z.boolean(), available: z.boolean(), systemRunsOn: z.boolean(), canEnableSystemRuns: z.boolean(), cap: UpkeepCapSchema, spend: UpkeepSpendSchema.optional(),
}).strict();
export type UpkeepView = z.infer<typeof UpkeepViewSchema>;

// ---- The company's one control (L4-P3, owner 2026-11-17) -------------------------------------------------------------------------------------------------------------------------------

/**
 * The company-level route for the consent itself: a live company owner or admin reads it (GET) and allows or withdraws it (PUT). Hosted only, a page session only (a script token never reaches it).
 * ALLOWING (`allowed: true`) needs a FRESH STEP-UP (a passkey or an emailed code, the same rule as making a script token), checked before the body is acted on; the refusal is REAUTH_REQUIRED (403) with
 * `SYSTEM_RUNS_CONSENT_WORDS.needsSignIn`. WITHDRAWING (`allowed: false`) needs only the live owner or admin role (turning off must be easy), works while the operator's ceiling is off, writes one audit record
 * (`SYSTEM_RUNS_CONSENT_AUDIT`) before the row, and leaves every project's own switch exactly as it is (they read as off while the consent is off). Future runs stop at once: the effective gate is read on every use.
 */
export const SYSTEM_RUNS_ROUTE = { method: "GET and PUT", path: "/v1/app/company/system-runs" } as const;
/** The PUT body: strict, a request id (one act per id AND choice) and the choice. */
export const SystemRunsBodySchema = z.object({ requestId: z.string().uuid(), allowed: z.boolean() }).strict();
export type SystemRunsBody = z.infer<typeof SystemRunsBodySchema>;
/**
 * What GET and PUT answer. `available`: the operator ceiling covers this company (false: nothing can be allowed yet, a withdrawal still works). `allowed`: the company's own stored consent. `systemRunsOn`:
 * EFFECTIVE (ceiling AND consent, read now), the same number as the project upkeep view's.
 */
export const SystemRunsViewSchema = z.object({ available: z.boolean(), allowed: z.boolean(), systemRunsOn: z.boolean() }).strict();
export type SystemRunsView = z.infer<typeof SystemRunsViewSchema>;
