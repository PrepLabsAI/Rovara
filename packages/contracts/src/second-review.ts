// Second review by a different AI company (setup-test-health design section 9, owner decision 9): an ADDED second opinion on a task's code from a model of another company than the one that
// wrote it. It runs in `shadow` first (the findings are recorded and shown on the task page as "second opinion", never block, never go on the pull request) and only later in `on` (its blocking
// findings block like the first review's: a code failure, send back). It is off by default, and `on` is reached only for a model that passed the replay check and the shadow acceptance below.
//
// This file is pure and browser-safe: names, fixed words, strict shapes and small pure functions. Nothing here carries a model's text except through the existing review report shape, which the
// task page renders as plain text like the first review's.
import { z } from "zod";
import { MODEL_COMPANIES } from "./models.js";
import { bedrockWithoutRegion } from "./models-node.js";
import { WorkflowReviewReportSchema } from "./task-workflow.js";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The setting: `review.otherCompany`
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Owner decision (2026-11-02, replacing the Bedrock-only rule): the second reviewer may run on any model source the company has connected, plus Rovara's own sources (Bedrock, OpenRouter, direct providers).
 * Which models those are is decided where the plan is made, from the same sources chat and dispatch use (`servableModels` / `servingRoutes`); there is no provider list here.
 */

/** The tag a second review's operation record carries (`secondReview: true`) and its receipts' purpose. Every lookup that reads reviews of a task must leave such an operation out. */
export const SECOND_REVIEW_OPERATION_TAG = "second-review";
/** Whether an operation item is a second review's. */
export const isSecondReviewOperation = (item: { secondReview?: unknown }): boolean => item.secondReview === true;

/** Ordered from the least careful to the most careful: the order a company lock compares in. */
export const SECOND_REVIEW_MODES = ["off", "shadow", "on"] as const;
export const SecondReviewModeSchema = z.enum(SECOND_REVIEW_MODES);
export type SecondReviewMode = z.infer<typeof SecondReviewModeSchema>;

/** The project setting `review.otherCompany`: a mode, or absent (the company's default stands). */
export const SecondReviewProjectSettingSchema = z.object({ otherCompany: SecondReviewModeSchema }).strict();
/** The company's side: a default for projects that did not choose, and a lock (a floor) projects cannot go below. */
export const SecondReviewCompanySettingSchema = z.object({ default: SecondReviewModeSchema.optional(), lock: SecondReviewModeSchema.optional() }).strict();
export type SecondReviewProjectSetting = z.infer<typeof SecondReviewProjectSettingSchema>;
export type SecondReviewCompanySetting = z.infer<typeof SecondReviewCompanySettingSchema>;

/**
 * What a driving test or a verdict is about: the exact model REVISION, not the family. `canonicalModelName` drops a Bedrock revision on purpose (so a forbidden `nova-pro` covers every version), but a test or a
 * verdict on `amazon.nova-pro-v1:0` says nothing about `amazon.nova-pro-v2:0`. The key is the provider and the model id with a Bedrock geography dropped (`us.amazon.nova-pro-v1:0` and `eu.amazon.nova-pro-v1:0` are
 * the same model, v1 and v2 are not); any other provider's id is lower-cased as it is.
 */
export function secondReviewModelKey(model: { provider: string; modelId: string }): string {
  const provider = model.provider.toLowerCase();
  return `${provider}:${provider === "amazon-bedrock" ? bedrockWithoutRegion(model.modelId) : model.modelId.toLowerCase()}`;
}

const modeRank = (mode: SecondReviewMode): number => SECOND_REVIEW_MODES.indexOf(mode);

/** The more careful of two modes (a company lock is a floor: M8, stricter only). */
export const stricterSecondReviewMode = (left: SecondReviewMode, right: SecondReviewMode): SecondReviewMode => (modeRank(left) >= modeRank(right) ? left : right);

/**
 * Lowering needs a second person, like loosening a company lock (SH29): a project's `review.otherCompany` going from `on` to `shadow` or `off`, and a company lock going to any lower mode (or being removed).
 * Raising, and a project going from `off` to `shadow`, from `shadow` to `off`, or between the same modes, applies at once (it only observes, or only makes work more careful). The route that applies a change
 * asks this and, when true, takes it through `decideSecondPersonApproval` (and its sole-owner exception) before it writes.
 */
export const projectSecondReviewLoweringNeedsSecondPerson = (from: SecondReviewMode, to: SecondReviewMode): boolean => from === "on" && to !== "on";
export const lockSecondReviewLoweringNeedsSecondPerson = (from: SecondReviewMode | undefined, to: SecondReviewMode | undefined): boolean => modeRank(to ?? "off") < modeRank(from ?? "off");

/**
 * The mode writer's rule (owner decision 2026-11-02, lane cr-settings): ANY lowering of `review.otherCompany`, for the company or for a project, needs a second admin (the one-admin rule): `on` to `shadow` or `off`, and
 * `shadow` to `off`. Raising, and setting the same mode again, applies at once. A project override can only be as strict as the company's mode or stricter, so a project's lowering is judged on the mode it
 * effectively has before and after (clearing an override can lower it to the company's mode).
 */
export const secondReviewModeLoweringNeedsSecondPerson = (from: SecondReviewMode, to: SecondReviewMode): boolean => modeRank(to) < modeRank(from);

/**
 * The mode a project is configured for: its own choice, else the company's default, else `off`; never below the company's lock. A lock never loosens a project, and a project's own choice never
 * goes under the lock. This is the CONFIGURED mode: `on` still needs a model that earned it (`SecondReviewVerdict`), and the install switch `cr` still has to be on.
 */
export function configuredSecondReviewMode(input: { project?: SecondReviewMode | undefined; companyDefault?: SecondReviewMode | undefined; companyLock?: SecondReviewMode | undefined }): SecondReviewMode {
  const chosen = input.project ?? input.companyDefault ?? "off";
  return stricterSecondReviewMode(chosen, input.companyLock ?? "off");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// What a second review leaves on the task: the second opinion
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Why a second review did not run (fixed words, shown as such). */
export const SECOND_REVIEW_SKIP_REASONS = ["switch-off", "mode-off", "no-reference-model", "no-candidate", "choice-not-qualifying"] as const;
export type SecondReviewSkipReason = (typeof SECOND_REVIEW_SKIP_REASONS)[number];

/**
 * The second opinion on one candidate of a task. `report` is the ordinary review report the worker wrote for the second reviewer's model; `mode` is the mode it RAN in (never the configured one:
 * a configured `on` that had no verified model ran in `shadow`, and says `downgraded`). `blocked` is whether it blocked; in `shadow` it is always false, and `wouldHaveBlocked` says what `on` would have done.
 * `unavailable` is set when the reviewer gave no answer (the report is FAILED, INTERRUPTED or UNKNOWN): the first review stands alone, and the task page says the second opinion did not run.
 */
/** Why a second opinion is unavailable (fixed words): the reviewer gave no answer, or its answer was not accepted. */
export const SECOND_OPINION_UNAVAILABLE_REASONS = ["no-answer", "wrong-role", "wrong-candidate", "wrong-model", "same-company", "budget", "not-run", "no-candidate", "choice-not-qualifying", "older-worker"] as const;
export type SecondOpinionUnavailableReason = (typeof SECOND_OPINION_UNAVAILABLE_REASONS)[number];

/** Why a second reviewer's model was chosen. */
export const SECOND_REVIEW_CHOICES = ["company", "default"] as const;
export type SecondReviewChoice = (typeof SECOND_REVIEW_CHOICES)[number];

export const SecondOpinionSchema = z.object({
  mode: z.enum(["shadow", "on"]),
  downgraded: z.literal("replay-not-passed").optional(),
  /** The company of the second reviewer's model, never `other`. Absent only when no model was ever chosen (`no-candidate`). */
  company: z.enum(MODEL_COMPANIES.filter((company) => company !== "other") as [string, ...string[]]).optional(),
  /** The accepted report; absent when the second review did not run or its answer was not accepted (then `unavailableReason` says why). */
  report: WorkflowReviewReportSchema.optional(),
  unavailableReason: z.enum(SECOND_OPINION_UNAVAILABLE_REASONS).optional(),
  /** Why this model: the company named it (`review.otherCompanyModels`), or it is the default (the strongest model the company can use). Absent when no model was chosen. */
  choice: z.enum(SECOND_REVIEW_CHOICES).optional(),
  /** Set when the default model changed since this task's last second review because the earlier default no longer qualifies: the page says "Using default: <new> (previous no longer fits)". */
  defaultChanged: z.literal(true).optional(),
  blockingCount: z.number().int().min(0).max(20),
  blocked: z.boolean(),
  wouldHaveBlocked: z.boolean(),
  unavailable: z.boolean(),
}).strict().superRefine((opinion, context) => {
  if (opinion.mode === "shadow" && opinion.blocked) context.addIssue({ code: "custom", path: ["blocked"], message: "a shadow second opinion never blocks" });
  if (opinion.unavailable !== (opinion.report === undefined || opinion.unavailableReason !== undefined)) context.addIssue({ code: "custom", path: ["unavailable"], message: "unavailable exactly when there is no accepted answer" });
  if (!opinion.unavailable && opinion.company === undefined) context.addIssue({ code: "custom", path: ["company"], message: "an answered second opinion names the company of its model" });
  if (opinion.unavailable && (opinion.blocked || opinion.wouldHaveBlocked || opinion.blockingCount > 0)) context.addIssue({ code: "custom", path: ["blocked"], message: "an unavailable second opinion has no findings and blocks nothing" });
  if (opinion.blocked && !opinion.wouldHaveBlocked) context.addIssue({ code: "custom", path: ["blocked"], message: "a second opinion that blocked would have blocked" });
});
export type SecondOpinion = z.infer<typeof SecondOpinionSchema>;

/**
 * The words after "Second review did not run: " for each reason (owner decision, 2026-11-02, "Retry, then flag"). Fixed text, never a model's: it goes on the task page and, for `on`, on the pull request.
 */
export const SECOND_OPINION_UNAVAILABLE_TEXT: Readonly<Record<SecondOpinionUnavailableReason, string>> = {
  "no-answer": "the reviewer gave no usable answer after retrying",
  "wrong-role": "the answer was not the code review's",
  "wrong-candidate": "the answer was for other code than the current change",
  "wrong-model": "the answer came from a model other than the one planned",
  "same-company": "the model that answered is not from a different AI company",
  "budget": "there was not enough budget left",
  "not-run": "it had already run for this change",
  "no-candidate": "no allowed model from a different AI company could be used",
  "choice-not-qualifying": "the model chosen for it no longer qualifies (it must be from a different AI company than the one that wrote the code, and allowed)",
  "older-worker": "the worker that ran the review is not updated for it",
};
export const secondReviewDidNotRunLine = (reason: SecondOpinionUnavailableReason): string => `Second review did not run: ${SECOND_OPINION_UNAVAILABLE_TEXT[reason]}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The replay check (section 9.2). The quality suite (a manual run) fills one case per past task or planted diff; this file defines the fields and the bar.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The starting numbers of section 9.2, for the owner to adjust (change them here, in one place): 30+ past tasks with a known defect and 20+ planted-bug diffs; the candidate catches at least 80% of what
 * the current reviewer catches; it adds a real catch on at least 1 task in 10; its blocking findings that humans would dismiss stay under 1 per 5 tasks; then 2 weeks of shadow with more than 30% of
 * its findings accepted.
 */
export const SECOND_REVIEW_BAR = {
  minKnownDefects: 30,
  minPlantedBugs: 20,
  /** As a share out of 10: 8 is 80%. */
  catchShareTenths: 8,
  /** One real extra catch per this many tasks. */
  extraCatchEveryTasks: 10,
  /** Dismissed blocking findings must stay UNDER one per this many tasks. */
  dismissedUnderOnePerTasks: 5,
  shadowDays: 14,
  /** The shadow phase needs at least this many answered second opinions counted (a few findings over two weeks is not a track record). */
  shadowMinReviews: 10,
  /** Agreed findings must be MORE than this many in 10 (3 is 30%). */
  shadowAgreedOverTenths: 3,
} as const;

export const SECOND_REVIEW_REPLAY_CASES_MAX = 400;

/** One past task or planted diff, run through the current reviewer (the baseline) and through the candidate. Counts and flags only: no model text. */
export const SecondReviewReplayCaseSchema = z.object({
  caseId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  kind: z.enum(["known_defect", "planted_bug"]),
  baselineCaught: z.boolean(),
  candidateCaught: z.boolean(),
  /** Blocking findings the candidate raised on this case, and how many of them a human would dismiss (they are not the defect). */
  candidateBlockingFindings: z.number().int().min(0).max(20),
  candidateDismissedBlocking: z.number().int().min(0).max(20),
}).strict().refine((entry) => entry.candidateDismissedBlocking <= entry.candidateBlockingFindings, { message: "dismissed findings are a part of the blocking ones", path: ["candidateDismissedBlocking"] });
export type SecondReviewReplayCase = z.infer<typeof SecondReviewReplayCaseSchema>;

/** One replay run: the candidate and baseline models, when it ran and its cases. Fields for the quality suite to write; the broker only reads the verdict. */
export const SecondReviewReplayRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  ranAt: z.string().datetime(),
  candidate: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict(),
  baseline: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict(),
  cases: z.array(SecondReviewReplayCaseSchema).max(SECOND_REVIEW_REPLAY_CASES_MAX),
}).strict().refine((run) => new Set(run.cases.map((entry) => entry.caseId)).size === run.cases.length, { message: "a case appears twice", path: ["cases"] });
export type SecondReviewReplayRun = z.infer<typeof SecondReviewReplayRunSchema>;

export const SECOND_REVIEW_REPLAY_FAILURES = ["too-few-known-defects", "too-few-planted-bugs", "baseline-caught-nothing", "catch-share-low", "few-extra-catches", "too-many-dismissed"] as const;
export type SecondReviewReplayFailure = (typeof SECOND_REVIEW_REPLAY_FAILURES)[number];

export interface SecondReviewReplaySummary {
  tasks: number;
  knownDefects: number;
  plantedBugs: number;
  baselineCaught: number;
  /** Cases the baseline caught and the candidate caught too. */
  bothCaught: number;
  /** Cases the candidate caught and the baseline missed: real adds. */
  extraCatches: number;
  dismissedBlocking: number;
  passed: boolean;
  failures: SecondReviewReplayFailure[];
}

/** Scores a replay run against the bar. Integer arithmetic only (no rounding to argue about); a run that does not meet every part of the bar does not pass, and says which parts. */
export function summarizeSecondReviewReplay(cases: readonly SecondReviewReplayCase[]): SecondReviewReplaySummary {
  const knownDefects = cases.filter((entry) => entry.kind === "known_defect").length;
  const plantedBugs = cases.filter((entry) => entry.kind === "planted_bug").length;
  const baselineCaught = cases.filter((entry) => entry.baselineCaught).length;
  const bothCaught = cases.filter((entry) => entry.baselineCaught && entry.candidateCaught).length;
  const extraCatches = cases.filter((entry) => !entry.baselineCaught && entry.candidateCaught).length;
  const dismissedBlocking = cases.reduce((total, entry) => total + entry.candidateDismissedBlocking, 0);
  const tasks = cases.length;
  const failures: SecondReviewReplayFailure[] = [];
  if (knownDefects < SECOND_REVIEW_BAR.minKnownDefects) failures.push("too-few-known-defects");
  if (plantedBugs < SECOND_REVIEW_BAR.minPlantedBugs) failures.push("too-few-planted-bugs");
  if (baselineCaught === 0) failures.push("baseline-caught-nothing");
  else if (bothCaught * 10 < baselineCaught * SECOND_REVIEW_BAR.catchShareTenths) failures.push("catch-share-low");
  if (tasks === 0 || extraCatches * SECOND_REVIEW_BAR.extraCatchEveryTasks < tasks) failures.push("few-extra-catches");
  if (tasks > 0 && dismissedBlocking * SECOND_REVIEW_BAR.dismissedUnderOnePerTasks >= tasks) failures.push("too-many-dismissed");
  return { tasks, knownDefects, plantedBugs, baselineCaught, bothCaught, extraCatches, dismissedBlocking, passed: failures.length === 0, failures };
}

/**
 * The shadow phase: at least 2 weeks of live tasks, with more than 30% of the second opinion's findings AGREED WITH or FIXED by people. `agreed` is its own count (a person marked the finding right, or the next
 * round fixed what it named); it is NOT the owner's accepted-risk list (`AcceptedFindingRef`), which means "ship it anyway" and is the opposite signal.
 */
export const SecondReviewShadowResultSchema = z.object({
  days: z.number().int().min(0).max(3650),
  findings: z.number().int().min(0).max(1_000_000),
  agreed: z.number().int().min(0).max(1_000_000),
  /** Answered second opinions counted. Absent (a verdict written before it existed) is none, so it cannot pass the bar. */
  reviews: z.number().int().min(0).max(1_000_000).optional(),
}).strict().refine((result) => result.agreed <= result.findings, { message: "agreed findings are a part of the findings", path: ["agreed"] });
export type SecondReviewShadowResult = z.infer<typeof SecondReviewShadowResultSchema>;

export function secondReviewShadowPassed(result: SecondReviewShadowResult): boolean {
  return result.days >= SECOND_REVIEW_BAR.shadowDays && (result.reviews ?? 0) >= SECOND_REVIEW_BAR.shadowMinReviews && result.findings > 0 && result.agreed * 10 > result.findings * SECOND_REVIEW_BAR.shadowAgreedOverTenths;
}

/**
 * The evidence that lets a model run in `on`. It holds NO verdict flag: whether the replay check passed and whether the shadow phase passed are recomputed by the broker every time, from the stored replay run
 * (`summarizeSecondReviewReplay`) and the shadow window's timestamps and counts (`secondReviewVerdictHolds`). No route writes a pass; a record is created only by Rovara staff in Public or by the install in
 * Enterprise (never by a project), and an admin can only WITHDRAW it (`withdrawnAt`).
 */
export const SecondReviewVerdictSchema = z.object({
  /** `secondReviewModelKey` of the candidate: the exact revision, so a verdict on v1 never covers v2. */
  model: z.string().min(1).max(256),
  /** The stored replay run this verdict rests on, and the baseline reviewer it was compared with. */
  replayRunId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  baseline: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict(),
  /** The shadow window (it must start after the replay run) and what it counted. */
  shadow: z.object({ startedAt: z.string().datetime(), endedAt: z.string().datetime(), findings: z.number().int().min(0).max(1_000_000), agreed: z.number().int().min(0).max(1_000_000), reviews: z.number().int().min(0).max(1_000_000).optional() }).strict()
    .refine((window) => window.agreed <= window.findings, { message: "agreed findings are a part of the findings", path: ["agreed"] }),
  createdAt: z.string().datetime(),
  /** Who recorded it: a Rovara staff member (Public) or the install (Enterprise); never a project member. */
  createdBy: z.string().min(1).max(128),
  withdrawnAt: z.string().datetime().optional(),
  withdrawnBy: z.string().min(1).max(128).optional(),
}).strict().refine((verdict) => (verdict.withdrawnAt === undefined) === (verdict.withdrawnBy === undefined), { message: "withdrawnAt and withdrawnBy go together", path: ["withdrawnBy"] });
export type SecondReviewVerdict = z.infer<typeof SecondReviewVerdictSchema>;

const DAY_MS = 86_400_000;
const sameModelRef = (left: { provider: string; modelId: string }, right: { provider: string; modelId: string }): boolean => left.provider.toLowerCase() === right.provider.toLowerCase() && left.modelId.toLowerCase() === right.modelId.toLowerCase();

/**
 * Whether a verdict lets its model run in `on` NOW: not withdrawn; the replay run it names is the one given, ran this model against this baseline, and PASSES the bar when scored afresh; the shadow window
 * starts after that run, lasts the bar's days, and its counts clear the bar's share. Anything unreadable or missing is false.
 */
export function secondReviewVerdictHolds(verdict: SecondReviewVerdict, run: SecondReviewReplayRun | undefined): boolean {
  if (verdict.withdrawnAt !== undefined || run === undefined || run.runId !== verdict.replayRunId) return false;
  if (secondReviewModelKey(run.candidate) !== verdict.model || !sameModelRef(run.baseline, verdict.baseline)) return false;
  if (!summarizeSecondReviewReplay(run.cases).passed) return false;
  const started = Date.parse(verdict.shadow.startedAt);
  const ended = Date.parse(verdict.shadow.endedAt);
  const replayed = Date.parse(run.ranAt);
  if ([started, ended, replayed].some(Number.isNaN) || started <= replayed || ended < started) return false;
  return secondReviewShadowPassed({ days: Math.floor((ended - started) / DAY_MS), findings: verdict.shadow.findings, agreed: verdict.shadow.agreed, ...(verdict.shadow.reviews === undefined ? {} : { reviews: verdict.shadow.reviews }) });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The track record (lane cr-settings): what a model's second opinions came to on this company's own tasks, shown on the settings page for the admin's "turn on" decision, and counted into the verdict's shadow window
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What became of one finding the second reviewer raised: nobody has acted yet (`open`), the next round no longer had it (`fixed`: agreed with), or the owner accepted it as a risk / the task merged with it standing (`wrong`). */
export const SECOND_REVIEW_FINDING_OUTCOMES = ["open", "fixed", "wrong"] as const;
export type SecondReviewFindingOutcome = (typeof SECOND_REVIEW_FINDING_OUTCOMES)[number];

/** One answered second opinion of a task, for one candidate, as the track record keeps it. The findings are fingerprints only (`workflowFindingFingerprint`), never text. */
export const SecondReviewTrackRowSchema = z.object({
  model: z.string().min(1).max(256),
  mode: z.enum(["shadow", "on"]),
  taskId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/u),
  project: z.string().min(1).max(100),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  recordedAt: z.string().datetime(),
  /** The first review had already cleared this code when the second opinion came in: a finding that is then fixed is one the first review missed. */
  firstCleared: z.boolean(),
  /**
   * `fp` is the finding's exact fingerprint (it moves with the line number). `key` is its STABLE key (a hash of the cited file and the normalised text, never the line), and `file` a hash of the cited file's path: two
   * rounds that word or place the same finding alike share a `key`. Both are absent on a row written before they existed, and on a finding that cites no file (`file`).
   */
  findings: z.array(z.object({ fp: z.string().regex(/^[a-f0-9]{64}$/u), outcome: z.enum(SECOND_REVIEW_FINDING_OUTCOMES), key: z.string().regex(/^[a-f0-9]{64}$/u).optional(), file: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict()).max(20),
  /** Bumped by every outcome write, so two writers cannot overwrite each other. */
  rev: z.number().int().min(0),
}).strict();
export type SecondReviewTrackRow = z.infer<typeof SecondReviewTrackRowSchema>;

/** The numbers the settings page shows for a model on a company. All counts, no text. */
export interface SecondReviewTrackRecord {
  model: string;
  /** Whole days from the first to the last answered opinion on record (0 with none). */
  days: number;
  firstAt?: string;
  lastAt?: string;
  /** Answered second opinions (a review that gave no answer is not counted). */
  reviews: number;
  /** Blocking findings raised. */
  findings: number;
  /** Agreed with or fixed: the next round no longer had the finding. */
  agreed: number;
  /** Wrong: the owner accepted it as a risk, or the task merged with it still standing. */
  wrong: number;
  /** Nobody has acted yet. */
  open: number;
  /** Agreed findings on code the first review had already cleared: what the second opinion caught and the first missed. */
  caughtMissedByFirst: number;
}

/** Counts a model's rows. The same function feeds the settings page and the verdict's shadow window, so the page and the evidence cannot disagree. */
export function summarizeSecondReviewTrack(model: string, rows: readonly SecondReviewTrackRow[], window?: { from: string; to: string }): SecondReviewTrackRecord {
  const inWindow = rows.filter((row) => row.model === model && (window === undefined || (row.recordedAt >= window.from && row.recordedAt <= window.to)))
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  const count = (outcome: SecondReviewFindingOutcome, only?: (row: SecondReviewTrackRow) => boolean) => inWindow.reduce((total, row) => total + (only === undefined || only(row) ? row.findings.filter((finding) => finding.outcome === outcome).length : 0), 0);
  const firstAt = inWindow[0]?.recordedAt, lastAt = inWindow.at(-1)?.recordedAt;
  return {
    model, days: firstAt === undefined || lastAt === undefined ? 0 : Math.floor((Date.parse(lastAt) - Date.parse(firstAt)) / DAY_MS), ...(firstAt === undefined ? {} : { firstAt }), ...(lastAt === undefined ? {} : { lastAt }),
    reviews: inWindow.length, findings: inWindow.reduce((total, row) => total + row.findings.length, 0),
    agreed: count("fixed"), wrong: count("wrong"), open: count("open"), caughtMissedByFirst: count("fixed", (row) => row.firstCleared),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Starting a second review (SR-1): the reviewer inside the REVIEW operation, the tries it makes, the words it leaves
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The reason a workflow blocks with when the second review (in `on`) found problems the change introduced. One fixed sentence: the findings are on the task, never in the reason. */
export const SECOND_REVIEW_BLOCK_REASON = "the second review did not pass";

/** The result key the worker writes the second reviewer's outcome under, beside `workflowReviews` (never inside it, so an older broker that ignores the key can never take it for the first review's). */
export const SECOND_REVIEW_RESULT_KEY = "workflowSecondReview";

/** The most tries one second review makes in all (owner decision, 2026-11-02): the first, one retry on the same model, then the next allowed candidate. */
export const SECOND_REVIEW_TRIES_MAX = 3;
/** The most models the broker names for one second review. With 3 tries, a third name could never be reached after the first model's retry. */
export const SECOND_REVIEW_CANDIDATES_MAX = 2;

/**
 * What the second reviewer is shown besides the code change and the task description (owner decision, 2026-11-02, option C): by default NOTHING from connected sources (no Slack, Jira or other source tools, no
 * learned lessons, no step instructions or skills). A company can choose `same_as_first`, which gives it what the first reviewer has. Widening what is shared is an admin's browser-session change, audited.
 */
export const SECOND_REVIEW_CONTEXTS = ["change_only", "same_as_first"] as const;
export const SecondReviewContextSchema = z.enum(SECOND_REVIEW_CONTEXTS);
export type SecondReviewContext = z.infer<typeof SecondReviewContextSchema>;

/** A model a company may name for its second reviewer (`review.otherCompanyModels`): provider and model id, nothing else. */
export const SecondReviewModelRefSchema = z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict();
export type SecondReviewModelRef = z.infer<typeof SecondReviewModelRefSchema>;

/** The company's choice (owner decision, 2026-11-02): a primary model and an optional backup, in that order, no model twice (by exact revision). When set it replaces the default. */
export const SECOND_REVIEW_COMPANY_MODELS_MAX = 2;
export const SecondReviewModelListSchema = z.array(SecondReviewModelRefSchema).max(SECOND_REVIEW_COMPANY_MODELS_MAX)
  .refine((models) => new Set(models.map(secondReviewModelKey)).size === models.length, { message: "a model appears twice" });

/**
 * The list a task's second reviewer is chosen from, in order, and why. The company's list (when it set one) replaces the default order. A project may NARROW it to a subset, never widen it: an entry the
 * company's list does not hold is dropped, and a project that names only models the company did not name ends with an empty list (no second reviewer), never the company's whole list. With no company
 * list the project's list is a subset of the default pool: `undefined` means "no list, use the default order", an array means "only these, in this order".
 */
export function narrowedSecondReviewModels(input: { company?: readonly SecondReviewModelRef[] | undefined; project?: readonly SecondReviewModelRef[] | undefined }): { models: SecondReviewModelRef[] | undefined; choice: SecondReviewChoice } {
  // `undefined` is "nobody chose"; an empty list is a choice that holds nothing (an unreadable one), which must never fall back to the default.
  const company = input.company === undefined ? undefined : [...input.company];
  const project = input.project;
  if (company === undefined) return { models: project === undefined ? undefined : [...project], choice: "default" };
  if (project === undefined) return { models: company, choice: "company" };
  const keep = new Set(project.map(secondReviewModelKey));
  return { models: company.filter((model) => keep.has(secondReviewModelKey(model))), choice: "company" };
}

/**
 * Whether a second reviewer's report says its model could not serve this account, so the next try leaves that model out: a refused key (this includes a model the account has not enabled, `key-rejected ModelNotEnabled`),
 * a model not found or not in the catalog, a failure the worker could not classify (`unknown`: the model proxy's 403 for a model the account cannot use read as this before 2026-11-03, and moving to the next model costs
 * nothing), a 402, `MODEL_NOT_ALLOWED`, a model the install does not serve. NOT `request-rejected`: a request the provider refused includes a prompt over the model's context length (a long diff on a model with a small
 * window), which says nothing about whether the account can use the model.
 */
export function secondReviewModelUnusable(report: { modelFailure?: string | undefined }): boolean {
  const failure = report.modelFailure;
  if (failure === undefined) return false;
  return /\bthe model call failed: (?:key-rejected|model-not-found|not-in-catalog|unknown)\b/u.test(failure)
    || /\bthe model call failed: [a-z-]+(?: [A-Za-z0-9_]+)? HTTP 402\b/u.test(failure)
    || /^MODEL_NOT_ALLOWED:/u.test(failure)
    || /\bis not available on this install\b/u.test(failure);
}

/** One try of a second review: the model, and how it ended. A context-length rejection is `no-answer`, never `unusable`. */
export interface SecondReviewTry { model: SecondReviewModelRef; outcome: "answered" | "no-answer" | "unusable" }

/**
 * The next model to try, or none. At most `SECOND_REVIEW_TRIES_MAX` tries in all; a model that gave no answer is tried once more; a model that gave no answer twice, or that the account cannot use, is left out and
 * the next candidate is tried. The one place this order lives: the worker runs it, the tests check it.
 */
export function nextSecondReviewModel(candidates: readonly SecondReviewModelRef[], tries: readonly SecondReviewTry[]): SecondReviewModelRef | undefined {
  if (tries.length >= SECOND_REVIEW_TRIES_MAX || tries.some((entry) => entry.outcome === "answered")) return undefined;
  const of = (model: SecondReviewModelRef) => tries.filter((entry) => secondReviewModelKey(entry.model) === secondReviewModelKey(model));
  return candidates.find((model) => of(model).every((entry) => entry.outcome === "no-answer") && of(model).length < 2);
}

/** How a finished try ended, from the report the reviewer wrote (`undefined`: no report at all). */
export function secondReviewTryOutcome(report: { status: string; modelFailure?: string | undefined } | undefined): SecondReviewTry["outcome"] {
  if (report === undefined) return "no-answer";
  if (report.status === "PASS" || report.status === "FINDINGS") return "answered";
  return secondReviewModelUnusable(report) ? "unusable" : "no-answer";
}

/** The worker's whole answer for the second reviewer: the report of the last try (an answer, or the last failure), and how many tries it made. Strict, bounded, no free text beyond the report's own fixed shape. */
export const SecondReviewResultSchema = z.object({
  report: WorkflowReviewReportSchema.optional(),
  tries: z.number().int().min(0).max(SECOND_REVIEW_TRIES_MAX),
}).strict();
export type SecondReviewResult = z.infer<typeof SecondReviewResultSchema>;

/**
 * The line that says which model reviewed and why ("Reviewed by gpt-5.5 on openrouter (company choice)", or "Using default: gpt-5.5 (change)" while nobody has chosen). The model's name is a report string: the caller makes it inert/plain before showing it. The provider is
 * named as it is recorded (a Bedrock model reads "amazon-bedrock").
 */
export function secondReviewedByLine(input: { provider: string; modelId: string; choice: SecondReviewChoice | undefined; defaultChanged?: boolean | undefined }): string {
  // Nobody chose: the default is shown with the way to change it. The company chose: its choice is named.
  if (input.choice === "default") return `Using default: ${input.modelId} (${input.defaultChanged === true ? "previous no longer fits" : "change"})`;
  return `Reviewed by ${input.modelId} on ${input.provider}${input.choice === "company" ? " (company choice)" : ""}`;
}
