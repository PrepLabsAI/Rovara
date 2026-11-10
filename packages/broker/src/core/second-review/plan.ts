// Second review by a different AI company: an ADDED second opinion on a task's code from a model of another company than the one
// that wrote it, in `shadow` (recorded and shown on the task page as "second opinion", never blocking, never on the pull request) and then `on` (its blocking findings block like the first review's:
// a code failure, send back). This is the one place the choice and the verdict are made, over values the caller gives it (the recorded models, what the account can serve, the driving tests, the
// verdicts); it reads nothing and calls no model. Whether it exists is the install's (the `enabled` seam of the service, `service.ts`): off, nothing is planned.
//
// What this relies on (do not weaken): `modelCompany` reads a Bedrock id's maker with or without a geography (`openai.gpt-oss` over Bedrock is OpenAI, as `gpt-5` is), and a model it cannot place is `other`,
// which never counts as different (`differentCompany`). The forbidden-model check is `forbiddenModelMatcher` through the critic's `candidatesOf`, which refuses an unrecognised Bedrock id whenever
// anything is forbidden and matches by `canonicalModelName`, so another route to a forbidden model is forbidden too.
import { isBatchVariant } from "./model-variants.js";
import {
  SECOND_REVIEW_CANDIDATES_MAX, SecondOpinionSchema, secondReviewDidNotRunLine, blockingFindings, modelCompany, narrowedSecondReviewModels, secondReviewModelKey, secondReviewVerdictHolds,
  type AcceptedFindingRef, type ModelCompany, type ModelIdentifier, type ModelSelection, type SecondOpinion, type SecondOpinionUnavailableReason, type SecondReviewChoice, type SecondReviewMode, type SecondReviewModelRef,
  type SecondReviewReplayRun, type SecondReviewSkipReason, type SecondReviewVerdict, type WorkflowReviewReport,
} from "@agentx/contracts";
import { createHash } from "node:crypto";
import { ROUTE_PROVIDER } from "@agentx/model-runtime/catalog";
import { inertLine } from "../proof/inert-text.js";
import { differentCompany, type CriticModelLimits } from "./model-ranking.js";
import { estimateSecondReviewUsd, secondReviewPicker, type PickerInput, type SecondReviewPrice } from "./picker.js";
export { estimateSecondReviewUsd, type SecondReviewPrice };

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The plan: whether a second review runs, in which mode, on which model
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface SecondReviewPlanInput {
  /** Whether the feature exists on this install. */
  switchOn: boolean;
  /** The CONFIGURED mode (`configuredSecondReviewMode`: project, company default, company lock). */
  mode: SecondReviewMode;
  /** The recorded models the second reviewer must differ in company from (`againstModels`: every build operation's and the first reviewer's). Empty: nothing can be shown to differ, so nothing runs. */
  against: readonly ModelIdentifier[];
  project: { approved?: readonly ModelIdentifier[] | undefined };
  forbidden: CriticModelLimits["forbidden"];
  /** The models the project's sources can serve for this org (empty when that is not known: the approved list stands in). */
  sources: readonly ModelIdentifier[];
  /** Models an earlier try of this task's second review found the account could not use (`secondReviewModelUnusable`). */
  unusable?: readonly ModelIdentifier[] | undefined;
  /** The company's choice (a primary and an optional backup, in order) and the project's narrowing of it (a subset, never wider). Absent: the default, the top suggestion of the picker, recorded as `default`. */
  companyModels?: readonly SecondReviewModelRef[] | undefined;
  projectModels?: readonly SecondReviewModelRef[] | undefined;
  /** A price per model, for the picker's cost estimate (suggestions say it). */
  price?: PickerInput["price"];
  /** The model this task's last second review used while nobody had chosen: when it no longer qualifies the default moves on and the plan says so (`defaultChanged`). */
  previousDefault?: SecondReviewModelRef | undefined;
  /** The task started before the frontier tier: the picker ranks as it did then (`CriticModelLimits.legacyRanking`). */
  legacyRanking?: boolean | undefined;
  /** The evidence on record and the replay runs it names: `on` is allowed for a model only while `secondReviewVerdictHolds` for one of them (recomputed here, never read as a stored pass). */
  verdicts: readonly SecondReviewVerdict[];
  replayRuns: readonly SecondReviewReplayRun[];
}

/** Why a model the company named was not used (fixed words). */
export type SecondReviewSkippedWhy = "not-routable" | "not-allowed" | "same-company" | "company-unknown" | "batch-only";
export interface SecondReviewSkipped { model: SecondReviewModelRef; why: SecondReviewSkippedWhy }

export type SecondReviewPlan =
  | { run: false; reason: SecondReviewSkipReason; skipped?: SecondReviewSkipped[] }
  | {
    run: true; mode: "shadow" | "on";
    /** The first model to try. */
    model: ModelSelection;
    /** The models to try, in order (at most `SECOND_REVIEW_CANDIDATES_MAX`; the worker makes at most 3 tries in all). `model` is the first. In `on`, only models whose evidence holds, so a later try never turns a blocking review into a silent one. */
    candidates: readonly ModelSelection[];
    company: Exclude<ModelCompany, "other">; downgraded?: "replay-not-passed"; against: readonly ModelIdentifier[];
    /** Why this list: the company named it, or it is the default (the top suggestion). */
    choice: SecondReviewChoice;
    /** Default only: the earlier default no longer qualifies, so the task says "Using default: <new> (previous no longer fits)". */
    defaultChanged?: true;
    /** Entries of the company's list that were left out, and why. */
    skipped: SecondReviewSkipped[];
  };

const selectionOf = (model: ModelIdentifier): ModelSelection => ({ provider: model.provider, modelId: model.modelId });

/** Whether the evidence on record lets `model` run in `on` NOW: a verdict for its exact revision that still holds against the replay run it names. */
const verified = (input: Pick<SecondReviewPlanInput, "verdicts" | "replayRuns">, model: ModelIdentifier): boolean => {
  const key = secondReviewModelKey(model);
  return input.verdicts.some((verdict) => verdict.model === key && secondReviewVerdictHolds(verdict, input.replayRuns.find((run) => run.runId === verdict.replayRunId)));
};

/**
 * Whether a second review runs for a task's code, and on which models. It never throws and never picks a model by accident: every refusal is a fixed word.
 * - The switch off, or the configured mode `off`: nothing runs.
 * - Models come only from the picker's list: the models the company can use (its connected sources plus Rovara's own, any provider), allowed (approved list, not forbidden, not found unusable), from a known
 *   company that differs from EVERY model in `against`. There is no driving-test gate: an eligible model runs in shadow at once.
 * - Nobody has chosen: the top suggestion (then the next, as the worker's backup), recorded as `default`. If the model the task used last time as the default no longer qualifies, the next one is used and the plan
 *   says `defaultChanged`.
 * - The company chose (a primary and an optional backup, a project may narrow it, never widen it): exactly those, in that order. One that no longer qualifies is NEVER swapped for another model; when none of
 *   them qualifies nothing runs (`choice-not-qualifying`) and the caller flags it. `skipped` says why each was left out.
 * - Configured `shadow` runs in shadow. Configured `on` runs in `on` only on models whose track record still holds (`secondReviewVerdictHolds`: the replay bar and two weeks of shadow); with none it runs in
 *   shadow and says `downgraded: "replay-not-passed"`, so a company that set `on` before the evidence is in is never blocked by an unproven reviewer.
 */
export function planSecondReview(input: SecondReviewPlanInput): SecondReviewPlan {
  if (!input.switchOn) return { run: false, reason: "switch-off" };
  if (input.mode === "off") return { run: false, reason: "mode-off" };
  if (input.against.length === 0) return { run: false, reason: "no-reference-model" };
  const picked = secondReviewPicker({ sources: input.sources, project: input.project, forbidden: input.forbidden, unusable: input.unusable, against: input.against, price: input.price, verdicts: input.verdicts, replayRuns: input.replayRuns, legacyRanking: input.legacyRanking });
  const { models: named, choice } = narrowedSecondReviewModels({ company: input.companyModels, project: input.projectModels });
  const skipped: SecondReviewSkipped[] = [];
  const find = (model: SecondReviewModelRef) => picked.entries.find((entry) => secondReviewModelKey(entry.model) === secondReviewModelKey(model));
  let tested: ModelIdentifier[];
  let defaultChanged = false;
  if (choice === "company") {
    // The company's own choice, in its order. Each entry must still qualify; one that does not is left out and said, never replaced by a model the company did not name.
    tested = [];
    for (const entry of named ?? []) {
      const found = find(entry);
      const why: SecondReviewSkippedWhy | undefined = found === undefined ? (isBatchVariant(entry) ? "batch-only" : "not-routable") : found.eligible ? undefined : found.ineligibleWhy;
      if (why === undefined) tested.push(entry); else skipped.push({ model: { provider: entry.provider, modelId: entry.modelId }, why });
    }
    if (tested.length === 0) return { run: false, reason: "choice-not-qualifying", skipped };
  } else {
    // Nobody chose (a project's subset of nothing is not a choice either): the suggestions in order.
    const narrowed = named === undefined ? undefined : new Set(named.map(secondReviewModelKey));
    tested = picked.suggested.filter((entry) => narrowed === undefined || narrowed.has(secondReviewModelKey(entry.model))).map((entry) => entry.model);
    if (tested.length === 0) return { run: false, reason: "no-candidate", skipped };
    if (input.previousDefault !== undefined && !tested.some((model) => secondReviewModelKey(model) === secondReviewModelKey(input.previousDefault!))) defaultChanged = true;
  }
  const company = (model: ModelIdentifier): Exclude<ModelCompany, "other"> => modelCompany(model) as Exclude<ModelCompany, "other">;
  const common = { against: [...input.against], choice, skipped, ...(defaultChanged ? { defaultChanged: true as const } : {}) };
  const listOf = (models: readonly ModelIdentifier[]): ModelSelection[] => models.slice(0, SECOND_REVIEW_CANDIDATES_MAX).map(selectionOf);
  if (input.mode === "on") {
    const proven = tested.filter((model) => verified(input, model));
    if (proven.length > 0) return { run: true, mode: "on", model: selectionOf(proven[0]!), candidates: listOf(proven), company: company(proven[0]!), ...common };
    return { run: true, mode: "shadow", model: selectionOf(tested[0]!), candidates: listOf(tested), company: company(tested[0]!), downgraded: "replay-not-passed", ...common };
  }
  return { run: true, mode: "shadow", model: selectionOf(tested[0]!), candidates: listOf(tested), company: company(tested[0]!), ...common };
}

/**
 * The models the second reviewer must differ in company from: the ran model of EVERY build operation in EVERY round of the task, and the first reviewer's ran model. A model nobody recorded is unknown, and an
 * unknown model can never be shown to differ, so one missing makes the list undefined (the caller plans nothing: `no-reference-model`).
 */
export function againstModels(input: { buildRanModels: ReadonlyArray<ModelIdentifier | undefined>; firstReviewerRan: ModelIdentifier | undefined }): ModelIdentifier[] | undefined {
  if (input.buildRanModels.length === 0 || input.firstReviewerRan === undefined || input.buildRanModels.some((model) => model === undefined)) return undefined;
  const all = [...input.buildRanModels as ModelIdentifier[], input.firstReviewerRan];
  const seen = new Set<string>();
  return all.filter((model) => { const key = `${model.provider.toLowerCase()}\0${model.modelId.toLowerCase()}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export { secondReviewModelUnusable } from "@agentx/contracts";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The opinion: what a finished second review means
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Whether the report names the proxy route the broker gave `candidate`: the route provider AND that route's alias (an alias on any other provider is not it). */
const routedAs = (input: { routeAliases?: Readonly<Record<string, string>> | undefined; report: Pick<WorkflowReviewReport, "provider" | "version"> }, candidate: ModelIdentifier): boolean =>
  input.report.provider === ROUTE_PROVIDER && input.routeAliases?.[secondReviewModelKey(candidate)] === input.report.version;

/** What the broker knows about the report it received, to decide whether to accept it. */
export interface SecondReportCheck {
  plan: Extract<SecondReviewPlan, { run: true }>;
  report: WorkflowReviewReport;
  /** The digest of the candidate the task has NOW. */
  currentCandidateDigest: string | undefined;
  /** For a model reached through a proxy route, the alias its report names as the model that ran (by `secondReviewModelKey`). */
  routeAliases?: Readonly<Record<string, string>> | undefined;
}

/**
 * Accepts a second report only when ALL hold: it is the code review's (CRITIC), it is about the current candidate, and the model the report says answered (the worker's own provider and version, from the reviewer
 * session) is one the plan named (its exact revision), and is still a different company from everything in `against`. Anything else is not accepted, and the second opinion is unavailable with the reason. (The
 * second reviewer runs inside the REVIEW operation, whose record names the FIRST reviewer's model, so the report's own model is the only evidence of what answered; the proxy's model fallback is off for these
 * calls, so a substitute is not expected: this is the check that does not take the worker's word for what it was asked.)
 */
export function acceptSecondReport(input: SecondReportCheck): { accepted: true } | { accepted: false; reason: Extract<SecondOpinionUnavailableReason, "wrong-role" | "wrong-candidate" | "wrong-model" | "same-company"> } {
  if (input.report.role !== "CRITIC") return { accepted: false, reason: "wrong-role" };
  if (input.currentCandidateDigest === undefined || input.report.candidateDigest !== input.currentCandidateDigest) return { accepted: false, reason: "wrong-candidate" };
  const ran: ModelIdentifier = { provider: input.report.provider, modelId: input.report.version };
  // The model that answered is the planned one by its exact name, or (a routed model) by the alias the broker gave its route. The company is the PLANNED model's: an alias says nothing of its maker.
  const planned = input.plan.candidates.find((candidate) => secondReviewModelKey(candidate) === secondReviewModelKey(ran) || routedAs(input, candidate));
  if (planned === undefined) return { accepted: false, reason: "wrong-model" };
  if (!input.plan.against.every((other) => differentCompany(planned, other))) return { accepted: false, reason: "same-company" };
  return { accepted: true };
}

export interface SecondOpinionInput extends SecondReportCheck {
  /** The owner's accepted-risk findings for this candidate: a finding the owner accepted never blocks. (NOT the shadow phase's `agreed` count.) */
  accepted?: readonly AcceptedFindingRef[] | undefined;
}

/**
 * The second opinion on one candidate. In `shadow` it never blocks; `wouldHaveBlocked` records what `on` would have done, which is what the shadow phase counts. In `on` its blocking findings (the ones the change
 * introduced and that are not advisory, as for the first review) block. A report that is not accepted (`acceptSecondReport`), or that gave no answer (FAILED, INTERRUPTED or UNKNOWN), is UNAVAILABLE: it carries
 * no findings, and `secondReviewBlocksWhenUnavailable` says what that means for `on` (today: nothing blocks). The opinion names the company of the model that ANSWERED and why that model was chosen.
 */
export function secondOpinionOf(input: SecondOpinionInput): SecondOpinion {
  const check = acceptSecondReport(input);
  if (!check.accepted) return secondOpinionUnavailable(input.plan, check.reason);
  if (input.report.status !== "PASS" && input.report.status !== "FINDINGS") return secondOpinionUnavailable(input.plan, "no-answer", input.report);
  const blocking = blockingFindings(input.report, input.accepted);
  const wouldHaveBlocked = blocking.length > 0;
  const planned = input.plan.candidates.find((candidate) => secondReviewModelKey(candidate) === secondReviewModelKey({ provider: input.report.provider, modelId: input.report.version }) || routedAs(input, candidate))!;
  const answered = modelCompany(planned) as Exclude<ModelCompany, "other">;
  const reportedModel = { provider: planned.provider, modelId: planned.modelId };
  return SecondOpinionSchema.parse({
    mode: input.plan.mode,
    ...(input.plan.downgraded === undefined ? {} : { downgraded: input.plan.downgraded }),
    company: answered,
    choice: input.plan.choice,
    ...(input.plan.defaultChanged === true ? { defaultChanged: true } : {}),
    // A routed model's report names its route alias; the opinion shows the model the broker planned.
    report: { ...input.report, provider: reportedModel.provider, version: reportedModel.modelId },
    blockingCount: Math.min(blocking.length, 20),
    blocked: input.plan.mode === "on" && wouldHaveBlocked,
    wouldHaveBlocked,
    unavailable: false,
  });
}

/**
 * An unavailable second opinion: no findings, nothing blocked. `report` is kept only for `no-answer` (the failed report says why, for the page); any other reason drops it, since it was not accepted. `company` is
 * absent when no model was ever chosen (`no-candidate`).
 */
export function secondOpinionUnavailable(plan: { mode: "shadow" | "on"; company?: Exclude<ModelCompany, "other"> | undefined; downgraded?: "replay-not-passed" | undefined; choice?: SecondReviewChoice | undefined }, reason: SecondOpinionUnavailableReason, report?: WorkflowReviewReport): SecondOpinion {
  return SecondOpinionSchema.parse({
    mode: plan.mode, ...(plan.downgraded === undefined ? {} : { downgraded: plan.downgraded }), ...(plan.company === undefined ? {} : { company: plan.company }), ...(plan.choice === undefined ? {} : { choice: plan.choice }),
    ...(report !== undefined && reason === "no-answer" ? { report } : {}), unavailableReason: reason,
    blockingCount: 0, blocked: false, wouldHaveBlocked: false, unavailable: true,
  });
}

/** What a second review that cannot run means: retry, then flag. */
export interface UnavailableDecision {
  /** Never: the added opinion is not a reason a task stops. */
  blocks: false;
  /** `on` says so on the task page; shadow stays silent. */
  showOnTaskPage: boolean;
  /** `on` says "Second review did not run: <reason>" on the pull request too; shadow never does. */
  showOnPullRequest: boolean;
  /** `on`: the task owner is asked to acknowledge before merge. Shadow: never. */
  askOwnerToAcknowledge: boolean;
  /** The line to show, or undefined where nothing is shown. */
  line: string | undefined;
}

/**
 * What it means that the second review could not run (no answer after the tries, an unusable or unaccepted report, no candidate model, no budget). `on`: do not block, but flag it on the task page and the pull
 * request and ask the task owner to acknowledge before merge. Shadow: silent. Every reason that stops the review from giving its opinion lands here, so none can pass silently.
 */
export function secondReviewUnavailableDecision(input: { mode: SecondReviewMode; reason: SecondOpinionUnavailableReason }): UnavailableDecision {
  const flagged = input.mode === "on";
  return { blocks: false, showOnTaskPage: flagged, showOnPullRequest: flagged, askOwnerToAcknowledge: flagged, line: flagged ? secondReviewDidNotRunLine(input.reason) : undefined };
}

/** Kept for callers that only ask whether it blocks: it never does. */
export const secondReviewBlocksWhenUnavailable = (input: { mode: SecondReviewMode; reason: SecondOpinionUnavailableReason }): boolean => secondReviewUnavailableDecision(input).blocks;

/**
 * Where a second opinion may be shown. The task page: any opinion with an answer, and an unavailable `on`; shadow that did not run is silent. The pull request: only an `on` opinion that blocked, or an `on` one that
 * did not run ("Second review did not run: <reason>"); a shadow opinion never.
 */
export function secondOpinionShownOn(opinion: Pick<SecondOpinion, "mode" | "blocked"> & { unavailable?: boolean }): { taskPage: boolean; pullRequest: boolean } {
  const unavailable = opinion.unavailable === true;
  return { taskPage: !unavailable || opinion.mode === "on", pullRequest: opinion.mode === "on" && (opinion.blocked || unavailable) };
}

/**
 * The acknowledgement the task owner is asked for before merge when an `on` second review did not run: one per candidate (the key is a hash of the candidate and the reason, so the same ask is not made twice and a
 * new candidate asks again). The ask itself goes through the existing ask-a-person mechanism; this says whether one is needed and what it says.
 */
export function secondReviewAcknowledgement(opinion: Pick<SecondOpinion, "mode" | "unavailable" | "unavailableReason">, candidateDigest: string): { required: false } | { required: true; key: string; text: string } {
  if (opinion.mode !== "on" || !opinion.unavailable || opinion.unavailableReason === undefined) return { required: false };
  return {
    required: true,
    key: createHash("sha256").update(`second-review-ack\n${candidateDigest}\n${opinion.unavailableReason}`, "utf8").digest("hex"),
    text: `${secondReviewDidNotRunLine(opinion.unavailableReason)}. Acknowledge before merging.`,
  };
}

/** Whether a merge must wait: an acknowledgement is required for this candidate and has not been given (`given` holds the keys the task owner acknowledged). */
export const mergeWaitsForSecondReview = (opinion: Pick<SecondOpinion, "mode" | "unavailable" | "unavailableReason"> | undefined, candidateDigest: string, given: readonly string[]): boolean => {
  const ack = opinion === undefined ? { required: false as const } : secondReviewAcknowledgement(opinion, candidateDigest);
  return ack.required && !given.includes(ack.key);
};

/** The most findings and characters a second opinion puts on a pull request. */
export const SECOND_OPINION_PR_FINDINGS_MAX = 5;
export const SECOND_OPINION_PR_LINE_MAX = 300;

/**
 * The lines a second opinion adds to a pull request description, or none when it is not shown there (`secondOpinionShownOn`). Everything the model wrote is UNTRUSTED text and goes through the same
 * `inertLine` as the first review's: redacted, control characters gone, `@` broken so nobody is mentioned, links reduced to text, no image, no HTML comment, issue words neutralised. The model's name is a
 * report string and is made inert too.
 */
export function secondOpinionPrLines(opinion: SecondOpinion, accepted?: readonly AcceptedFindingRef[]): string[] {
  if (!secondOpinionShownOn(opinion).pullRequest) return [];
  // An `on` second review that did not run: one fixed line, no model text.
  if (opinion.unavailable) return opinion.unavailableReason === undefined ? [] : [secondReviewDidNotRunLine(opinion.unavailableReason)];
  if (opinion.report === undefined) return [];
  // The same list the opinion blocked on: a finding the owner accepted as a risk is neither blocking nor listed.
  const blocking = blockingFindings(opinion.report, accepted);
  if (blocking.length === 0) return [];
  return [
    `Second review (${inertLine(`${opinion.report.provider}/${opinion.report.version}`, 80)}): ${String(blocking.length)} blocking ${blocking.length === 1 ? "finding" : "findings"}`,
    ...blocking.slice(0, SECOND_OPINION_PR_FINDINGS_MAX).map((finding) => `- ${inertLine(finding.text, SECOND_OPINION_PR_LINE_MAX)}${finding.file === undefined ? "" : ` (${inertLine(finding.file, 120)}${finding.line === undefined ? "" : `:${String(finding.line)}`})`}`),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Cost and admission
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export type SecondReviewAdmission = { admit: true } | { admit: false; reason: Extract<SecondOpinionUnavailableReason, "budget" | "not-run"> };

/**
 * Whether the second review is admitted, by the same rules as the first review (the wiring gives the first review's own answers: the payer and its budget floor in Public, the spend ledger in Enterprise).
 * `roomUsd` is what the payer has left above the floor. A second review the payer cannot afford is not run: in `shadow` it is skipped with the reason `budget`; in `on` it is unavailable for the same reason
 * (`secondReviewBlocksWhenUnavailable` decides what that means). It runs at most once per candidate per round (`alreadyRan`), and never when the first review did not run.
 */
export function admitSecondReview(input: { mode: "shadow" | "on"; estimateUsd: number; roomUsd: number; alreadyRan: boolean }): SecondReviewAdmission {
  if (input.alreadyRan) return { admit: false, reason: "not-run" };
  if (!Number.isFinite(input.estimateUsd) || !Number.isFinite(input.roomUsd) || input.estimateUsd > input.roomUsd) return { admit: false, reason: "budget" };
  return { admit: true };
}

/** Whether a second review already ran (or is running) for this candidate in this round: the operations of the task, by their tag. */
export function secondReviewAlreadyRan(operations: ReadonlyArray<{ secondReview?: unknown; candidateDigest?: unknown; round?: unknown }>, candidateDigest: string, round: number): boolean {
  return operations.some((item) => item.secondReview === true && item.candidateDigest === candidateDigest && item.round === round);
}
