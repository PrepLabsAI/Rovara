// L4-EVH (DEC 254zzz20 D5): the opt-in eval HEALTH RUN, the part that runs after a person said yes (`EVAL_HEALTH_REQUEST`, core/setup-agent/eval-health-request.ts). One run measures the project's evals on main three
// times (`runEvalHealth`), in a fresh sandbox, through the model gateway, and the broker keeps the result as the project's baseline and tells the person pass or fail per case, or why it did not run.
//
// What crosses the wire (the worker's one post, `eval-health-result`): which request and claim it answers, and either the measured baseline record or a closed reason. Nothing else: no cost, no company, no project, no
// key parts. The broker holds the claim (its own random id, written when the run was claimed), derives the cache key from ITS OWN plan, and reads the questions from ITS OWN plan; a body can only fill in answers.
import { z } from "zod";
import { EvalBaseRecordSchema } from "./eval-base-cache.js";
import { EvalBlockedReachSchema, evalBlockedReachClause, type EvalBlockedReach } from "./eval-run-diagnostic.js";
import { MEASURES_FILE_MAX_BYTES } from "./measures-file.js";

/** A yes older than this is not run (a person asked a day ago; the eval, the approval or the people may all have changed since). */
export const EVAL_HEALTH_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * A claimed run that has not reported in this long is over: it reads "Not run: it did not report back", and a new yes is allowed. A late result after this is not taken. It is SHORTER than the baseline's measuring
 * mark (60 minutes, `createDocumentBaseScoreCache`), so a task that arrives while a health run is live always reads "measuring" and never starts a second paid measurement of the same baseline.
 */
export const EVAL_HEALTH_RUN_MAX_MS = 58 * 60_000;
/** The worker feature (listed on /ping) that takes the prepare payload's `evalHealth`. A worker without it is never sent the job. */
export const PREPARE_EVAL_HEALTH_FEATURE = "prepare.evalHealth.v1" as const;
/** The callback actions of the health run's operation, and only its. */
export const EVAL_HEALTH_PLAN_PATH = "eval-health-plan" as const;
export const EVAL_HEALTH_RESULT_PATH = "eval-health-result" as const;
/** The result body's own bound: a measures file's bound plus its framing. */
export const EVAL_HEALTH_RESULT_MAX_BYTES = MEASURES_FILE_MAX_BYTES + 65_536;

/** The prepare payload's `evalHealth`: the request the run is for and the claim the broker made for it. Both are the broker's; neither is a credential on its own (the operation's signed capability is the other half). */
export const PrepareEvalHealthSchema = z.object({
  requestId: z.string().uuid(),
  claimId: z.string().uuid(),
}).strict();
export type PrepareEvalHealth = z.infer<typeof PrepareEvalHealthSchema>;

/**
 * Why a health run did not measure: the worker's own refusals (`EvalHealthRefusal`, and "questions_changed" and "stopped") and the broker's own, each with fixed words (`evalHealthNotRunWords`). The broker
 * refuses before a worker is asked: "expired", "requester_not_allowed", "approval_changed", "main_unreadable", "already_measuring", "could_not_start" and "no_report" (a claim that never reported).
 */
export const EVAL_HEALTH_NOT_RUN_REASONS = [
  "not_connected", "invalid_questions", "over_cap", "invalid_identity", "not_confirmed", "monthly_cap", "provider_incomplete", "invalid_results", "incomplete_questions", "unavailable", "questions_changed", "stopped", "blocked_connection",
  "expired", "requester_not_allowed", "approval_changed", "main_unreadable", "already_measuring", "could_not_start", "no_report",
] as const;
export type EvalHealthNotRunReason = (typeof EVAL_HEALTH_NOT_RUN_REASONS)[number];
export const EvalHealthNotRunReasonSchema = z.enum(EVAL_HEALTH_NOT_RUN_REASONS);

/** The reasons a WORKER may report (the rest are the broker's own: a worker cannot say a request expired or a claim never reported). */
export const EVAL_HEALTH_WORKER_REASONS = ["not_connected", "invalid_questions", "over_cap", "invalid_identity", "not_confirmed", "monthly_cap", "provider_incomplete", "invalid_results", "incomplete_questions", "unavailable", "questions_changed", "stopped", "blocked_connection"] as const satisfies readonly EvalHealthNotRunReason[];

/** What the worker posts. `measured` carries the baseline the three runs made, exactly as the cache would hold it; the broker checks it against its own plan before it keeps anything. */
export const EvalHealthResultBodySchema = z.object({
  requestId: z.string().uuid(),
  claimId: z.string().uuid(),
  result: z.discriminatedUnion("status", [
    z.object({ status: z.literal("measured"), record: EvalBaseRecordSchema }).strict(),
    /** TH1: `blocked` names what the sealed eval tried to reach (fixed shape, host names only), and only with `blocked_connection`. */
    z.object({ status: z.literal("not_run"), reason: z.enum(EVAL_HEALTH_WORKER_REASONS), blocked: EvalBlockedReachSchema.optional() }).strict(),
  ]),
}).strict().refine(b => b.result.status !== "not_run" || b.result.blocked === undefined || b.result.reason === "blocked_connection", "a blocked list belongs to a blocked connection");
export type EvalHealthResultBody = z.infer<typeof EvalHealthResultBodySchema>;

const WORDS: Readonly<Record<EvalHealthNotRunReason, string>> = {
  not_connected: "Not run: the eval check is not connected on this install yet.",
  invalid_questions: "Not run: the list of eval questions could not be read in full.",
  over_cap: "Not run: the three runs would cost more than the approved limit.",
  invalid_identity: "Not run: the eval could not be matched to your code.",
  not_confirmed: "Not run: the eval's spend is not approved by someone who can approve it now.",
  monthly_cap: "Not run: the monthly AI spending limit cannot fit these runs.",
  provider_incomplete: "Not run: the AI provider did not answer every question.",
  invalid_results: "Not run: your eval's results could not be read in full.",
  incomplete_questions: "Not run: some eval questions had no result.",
  unavailable: "Not run: the eval could not be run.",
  questions_changed: "Not run: your eval questions changed since you approved them. Approve them again.",
  stopped: "Not run: the check was stopped.",
  blocked_connection: "Not run: your eval tried to reach something other than the model. Rovara's sealed check can't reach that yet.",
  expired: "Not run: your yes is more than a day old. Say yes again to run it.",
  requester_not_allowed: "Not run: the person who asked can no longer approve eval spending. Ask again.",
  approval_changed: "Not run: the eval's approval changed. Check it again.",
  main_unreadable: "Not run: your main branch could not be read.",
  already_measuring: "Not run: your evals are already being measured. Check again in a few minutes.",
  could_not_start: "Not run: the check could not be started. Nothing was spent.",
  no_report: "Not run: the check did not report back. Say yes again to retry.",
};
/** The fixed words for a reason. Never echoes a cause, a path or a provider word. */
export const evalHealthNotRunWords = (reason: EvalHealthNotRunReason, blocked?: EvalBlockedReach): string => (reason === "blocked_connection" && blocked !== undefined ? `Not run: ${evalBlockedReachClause(blocked)}.` : WORDS[reason]);
/** Said beside a measured result whose baseline could not be kept (the numbers are still shown). */
export const EVAL_HEALTH_NOT_SAVED_WORDS = "Measured, but the result could not be saved as your baseline." as const;
