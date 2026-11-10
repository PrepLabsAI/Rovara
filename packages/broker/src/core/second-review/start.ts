// Second review: the start. Called once from the REVIEW dispatch (`core/build-step/start.ts`), it decides whether the review this operation runs carries a second reviewer, which models it may try, and what
// to record on the operation either way. The second reviewer runs INSIDE the same REVIEW operation as an extra code review with its
// own model, so there is no second operation, no hold, no new dispatch row: a stop, a lost run, a stale sweep and a close all see one ordinary REVIEW operation.
//
// With the feature off, or the configured mode `off`, it returns nothing, and the dispatch is exactly today's.
import { randomUUID } from "node:crypto";
import {
  configuredSecondReviewMode, secondReviewModelKey, type InvocationModelRoute, type ModelSelection, type SecondOpinionUnavailableReason, type SecondReviewerPayload,
} from "@agentx/contracts";
import { againstModels, planSecondReview, type SecondReviewPlan } from "./plan.js";
import { estimateSecondReviewUsd, SECOND_REVIEW_TYPICAL_REVIEW_TOKENS } from "./picker.js";
import { noteQualification, observationOf } from "./notice.js";
import { isSecondReviewEnabled, secondReviewNow, type SecondReviewDeps } from "./seams.js";
import { readSecondReviewSettings } from "./settings.js";
import type { SecondReviewCap, SecondReviewOperationPlan, StoredSecondOpinion } from "./store.js";

export interface SecondReviewStartInput {
  task: { taskId: string; project: string; developerId?: string | undefined; secondOpinion?: unknown; workflow?: { candidate?: { digest: string } | undefined } | undefined } | undefined;
  /** The reviews this operation runs; absent: both. */
  reviewers?: readonly ("CRITIC" | "SECURITY")[] | undefined;
  /** The task's pin has no review-default marker (it started before the frontier tier): rank as it did then. */
  legacyRanking?: boolean | undefined;
}

export interface SecondReviewStart {
  /** The field for the worker payload (absent when nothing is to be run). */
  field?: SecondReviewerPayload;
  /** What to record on the operation (absent only when there is nothing to say: feature off, mode off, not a code review). */
  record?: SecondReviewOperationPlan;
}

/** The fixed reason an unplanned second review is flagged with. */
const REASON_OF: Record<Extract<SecondReviewPlan, { run: false }>["reason"], SecondOpinionUnavailableReason | undefined> = {
  "switch-off": undefined, "mode-off": undefined, "no-reference-model": "no-candidate", "no-candidate": "no-candidate", "choice-not-qualifying": "choice-not-qualifying",
};

/** The stored opinion the previous review of this task left, when it was a default's (the plan then says whether the default moved on). */
const previousOpinionOf = (task: { secondOpinion?: unknown }): StoredSecondOpinion | undefined => (task.secondOpinion ?? undefined) as StoredSecondOpinion | undefined;

export async function prepareSecondReview(deps: SecondReviewDeps, input: SecondReviewStartInput): Promise<SecondReviewStart> {
  if (!isSecondReviewEnabled(deps)) return {};
  const candidate = input.task?.workflow?.candidate;
  if (input.task === undefined || candidate === undefined) return {};
  if (input.reviewers !== undefined && !input.reviewers.includes("CRITIC")) return {};
  const log = deps.log ?? (() => undefined);
  const now = secondReviewNow(deps);
  let settings: Awaited<ReturnType<typeof readSecondReviewSettings>>;
  try { settings = await readSecondReviewSettings(deps.store, deps.companyId, input.task.project); } catch (error) {
    // Settings that cannot be read run nothing (never a looser setting); the first review goes on as today.
    log({ component: "broker", event: "second_review.settings_unreadable", errorName: error instanceof Error ? error.name : "unknown" });
    return {};
  }
  const mode = configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
  if (mode === "off") return {};
  const candidateDigest = candidate.digest;
  const notRun = (reason: SecondOpinionUnavailableReason): SecondReviewStart => ({ record: { candidateDigest, notRun: { mode: mode === "on" ? "on" : "shadow", reason } } });
  // Everything below only ADDS an opinion to the review: an error while planning (a source that cannot be read, a model lookup, an admission read) must never fail the first review's dispatch. It is logged (the
  // error's name only), and `on` flags that the second review did not run while shadow stays silent.
  // The allowance the admission port holds for this start, given back on every path where no operation will carry it (an operation's end gives it back otherwise).
  let held: string | undefined;
  try {
    // Every build the task ran in every round, and the first reviewer's model: the second reviewer must differ in company from all of them. One that recorded nothing can never be shown to differ.
    const ran = await deps.seams.taskModels(input.task);
    const against = againstModels({ buildRanModels: ran.builds, firstReviewerRan: ran.firstReviewer });
    if (against === undefined) return notRun("no-candidate");
    const forbidden = (await deps.seams.forbidden?.()) ?? [];
    const approved = await deps.seams.approved?.(input.task.project);
    const sources = await deps.seams.sources(input.task.project);
    const previous = settings.companyModels === undefined && settings.projectModels === undefined ? previousOpinionOf(input.task) : undefined;
    // Only an opinion that ANSWERED names the model that ran (a failed one keeps a report too, of whatever model failed).
    const previousModel = previous?.opinion.choice === "default" && previous.opinion.unavailable === false && previous.opinion.report !== undefined ? { provider: previous.opinion.report.provider, modelId: previous.opinion.report.version } : undefined;
    const price = deps.seams.price?.bind(deps.seams);
    const plan = planSecondReview({
      switchOn: true, mode, against, project: { approved }, forbidden, sources, verdicts: settings.verdicts, replayRuns: settings.replayRuns,
      companyModels: settings.companyModels, projectModels: settings.projectModels, previousDefault: previousModel, legacyRanking: input.legacyRanking,
      ...(price === undefined ? {} : { price }),
    });
    // The owner is told once when the reviewer stops qualifying (and again if it comes back and breaks later); best effort, never in the way of the review.
    await noteQualification(deps.store, deps.companyId, observationOf(plan), now, log);
    if (!plan.run) {
      const reason = REASON_OF[plan.reason];
      return reason === undefined ? {} : notRun(reason);
    }
    // Admission, the same as the first review's: the install's Admission port decides (Code: allow all; the hosted product: the payer's budget floor and the spend ledger). A refusal is "budget". An allowance the port holds back
    // (`reservationId`) is kept on the operation and given back when the operation ends (`operationEnded`), so the hold covers the second review's whole run. What the second reviewer may SPEND is capped in the model
    // proxy, per operation, on its own route (`caps` below): the operation's own budget does not cover a second model.
    const priceOf = deps.seams.price?.(plan.model);
    const estimateUsd = priceOf === undefined ? 0 : estimateSecondReviewUsd(priceOf, { input: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.input, maxOutput: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.output });
    const decision = await deps.admission.admit({
      companyId: deps.companyId, idempotencyKey: `second-review:${input.task.taskId}:${randomUUID()}`, action: "model.call", projectName: input.task.project,
      subject: { type: "task", id: input.task.taskId }, estimate: { cost: { micros: Math.round(estimateUsd * 1_000_000), currency: "USD" } },
    });
    if (!decision.allowed) return notRun("budget");
    const reservationId = decision.reservationId;
    held = reservationId;
    // Each model is reached the way the install checks it: through its own proxy route. A model no usable route serves is left out; with none left the review could not start.
    const candidates: Array<{ model: ModelSelection; modelRoute?: InvocationModelRoute }> = [];
    const aliases: string[] = [];
    const routeAliases: Record<string, string> = {};
    const caps: Record<string, SecondReviewCap> = {};
    for (const model of plan.candidates) {
      const route = await deps.seams.route(model, input.task.project);
      if (route === undefined) continue;
      candidates.push({ model, ...(route.workerRoute === undefined ? {} : { modelRoute: route.workerRoute }) });
      if (route.alias !== undefined) aliases.push(route.alias);
      if (route.workerRoute !== undefined) routeAliases[secondReviewModelKey(model)] = route.workerRoute.alias;
      if (route.cap !== undefined && route.alias !== undefined) caps[route.alias] = route.cap;
    }
    if (candidates.length === 0) {
      // Nothing will run, so nothing is held.
      if (reservationId !== undefined) await deps.admission.release(reservationId).catch(() => undefined);
      return notRun("no-candidate");
    }
    const kept = plan.candidates.filter((model) => candidates.some((entry) => secondReviewModelKey(entry.model) === secondReviewModelKey(model)));
    // What the second reviewer sees besides the change: nothing from connected sources unless the company chose `same_as_first` (absent on the wire means `change_only`).
    const field: SecondReviewerPayload = { candidates, ...(settings.context === "same_as_first" ? { context: settings.context } : {}) };
    return {
      field,
      record: { candidateDigest, plan: { mode: plan.mode, company: plan.company, model: kept[0]!, candidates: kept, against: plan.against, choice: plan.choice,
        ...(plan.downgraded === undefined ? {} : { downgraded: plan.downgraded }), ...(plan.defaultChanged === true ? { defaultChanged: true as const } : {}) },
        ...(aliases.length === 0 ? {} : { aliases }), ...(Object.keys(routeAliases).length === 0 ? {} : { routeAliases }), ...(Object.keys(caps).length === 0 ? {} : { caps }), ...(reservationId === undefined ? {} : { reservationId }) },
    };
  } catch (error) {
    if (held !== undefined) await deps.admission.release(held).catch(() => undefined);
    log({ component: "broker", event: "second_review.start_failed", errorName: error instanceof Error ? error.name : "unknown" });
    return mode === "on" ? notRun("no-candidate") : {};
  }
}
