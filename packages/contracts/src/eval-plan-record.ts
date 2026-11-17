// DEC 253j(1): the TRUSTED eval plan source. The EVAL_PLAN record holds what a final-check eval needs that does not change from task to task: the confirmed question list (each question's
// category, the repository file that holds it and that file's content hash at setup), the image and route settings, the two judge pins, the per-question call and cost caps and
// whether an eval is configured. It sits next to EVAL_SPEND, in the same company-scoped setup partition (`ORG#<company>#SETUP_DRAFT#<project>`, sort key `EVAL_PLAN`).
//
// WHO WRITES IT: only the broker, when setup proposes the eval spend item (`proposeEvalSpendApproval`). The plan's digest (`evalPlanDigest`) is written into that item's spend plan
// (`EvalSpendPlan.evalPlanDigest`), so the item's own digest, the one an approver approves, covers the plan. The record also names that item's digest (`spendDigest`).
//
// WHO READS IT: the broker's eval-plan source, and only for a record that is (1) this company's and this project's, (2) unedited (its digest recomputed from its body), (3) the one the
// spend item names, and (4) bound to an APPROVED spend item. Anything else is no plan. The per-task parts (the base commit, the code hash, each question's base and head hash) are not
// stored: the worker computes them from the pinned candidate and checks each question's base hash against this list (a mismatch is not runnable).
//
// DEC 253n(2): the plan also stores the confirmed eval COMMAND (an argv, no shell, and its working folder in the checkout) and the REPORT path the eval writes its measures to. Both are
// covered by the stored command hash: `key.commandFingerprint` must equal `evalCommandFingerprintOf(command, report)`, checked on every read here and again by the worker before the fresh
// check sandbox is built from them. A plan written before 253n has neither: it still reads, and its eval reads Not run (no command to run).
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { evalCommandFingerprint } from "./eval-base-cache.js";
import { isSafeE2ESourcePath } from "./e2e-source.js";
import { EVAL_QUESTION_LIMIT } from "./eval-check.js";
import { EvalSpendInputsSchema } from "./eval-spend.js";
import { sha256HexOf } from "./service-catalog-verify.js";

/** The sort key of the record in the project's setup partition. */
export const EVAL_PLAN_SORT_KEY = "EVAL_PLAN";
/** The largest question file the worker hashes (bytes), and the most it reads for one plan across both sides. */
export const EVAL_QUESTION_FILE_MAX_BYTES = 1_048_576;
export const EVAL_QUESTION_FILES_TOTAL_MAX_BYTES = 32 * 1_048_576;

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const whole = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const name = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/u);

/** One confirmed question: its id, its category, the repository file that holds it and that file's content hash (`evalQuestionHash`) when setup read it. */
export const EvalPlanQuestionSchema = z.object({
  id: z.string().min(1).max(160),
  category: z.enum(["ordinary", "safety", "refusal"]),
  path: z.string().min(1).max(512).refine(path => isSafeE2ESourcePath(path) && ![...path].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) && !path.includes(":"), "a question path is a plain repository-relative path"),
  hash,
}).strict();

/** A plain relative folder of the checkout: `.` or up to 32 plain segments, never `..`. The fresh sandbox's own rule (`eval-bridged-exec.ts`). */
const relativeFolder = z.string().min(1).max(512).regex(/^(?:\.|[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,31})$/u).refine(path => !path.split("/").includes(".."), "no parent segment");
/** The most characters every argument of the eval command may hold together. */
export const EVAL_COMMAND_ARGS_MAX_CHARS = 16_384;
/** The confirmed eval command: an argv run with no shell, in `cwd` (relative to the checkout). The fresh sandbox's own allow-list, so a plan never holds a command it would refuse. */
export const EvalCommandSchema = z.object({
  executable: z.string().regex(/^[A-Za-z0-9._/+-]{1,256}$/u),
  args: z.array(z.string().regex(/^[^\0\r\n]{0,8192}$/u)).max(256).refine(args => args.reduce((n, arg) => n + arg.length, 0) <= EVAL_COMMAND_ARGS_MAX_CHARS, "the arguments are too long"),
  cwd: relativeFolder,
}).strict();
export type EvalCommand = z.infer<typeof EvalCommandSchema>;
/** Where the eval writes its measures file: a folder of the checkout and the file there (both plain relative paths). */
export const EvalReportPathSchema = z.object({ cwd: relativeFolder, argument: relativeFolder.refine(path => path !== ".", "a file") }).strict();
export type EvalReportPath = z.infer<typeof EvalReportPathSchema>;

/** DEC 253n(2): the stored command hash of an eval command and its report path (`evalCommandFingerprint` of their canonical JSON under a fixed version). Throws (zod) for a command or path the schemas refuse. */
export function evalCommandFingerprintOf(command: EvalCommand, report: EvalReportPath): string {
  return evalCommandFingerprint(canonicalJson({ v: "rovara-eval-command/v1", command: EvalCommandSchema.parse(command), report: EvalReportPathSchema.parse(report) }));
}

/** The measurement settings fingerprint (setup measurement, refresh and task comparison share it; the worker's `evalSettingsFingerprint` is this one). */
export function evalSettingsFingerprintOf(settings: { readonly imageDigest: string; readonly route: string }, judgePin: string): string {
  return evalCommandFingerprint(JSON.stringify({ rule: "question-exact-v1", imageDigest: settings.imageDigest, route: settings.route, judgePin }));
}

/** The stored plan's fields (the worker extends them with the per-task key it receives). */
export const EvalPlanBodyShape = z.object({
  selection: z.string().min(1).max(512).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  /** The repository that holds the eval; optional for a single-repository project. */
  repository: z.string().trim().min(1).max(200).optional(),
  inputs: EvalSpendInputsSchema,
  key: z.object({ commandFingerprint: hash, catalogRowId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u), model: name, modelVersion: name }).strict(),
  settings: z.object({ imageDigest: z.string().min(1).max(2000), route: z.string().min(1).max(200) }).strict(),
  evalSetHash: hash,
  evalConfigured: z.boolean(),
  judgePin: hash,
  baselineJudgePin: hash,
  sameJudgeFamily: z.boolean().optional(),
  subsetSupported: z.boolean(),
  questions: z.array(EvalPlanQuestionSchema).max(EVAL_QUESTION_LIMIT),
  maxCallsPerQuestion: whole,
  maxCostMicrosPerQuestion: whole,
  /** DEC 253n(2): the confirmed eval command and report path, covered by `key.commandFingerprint`. Absent (a plan from before 253n): the eval has no command and reads Not run. */
  command: EvalCommandSchema.optional(),
  report: EvalReportPathSchema.optional(),
}).strict();

/** Whether a plan's command and report path are both present and hash to its stored command hash, or both absent. */
export function evalPlanCommandHolds(plan: { readonly command?: unknown; readonly report?: unknown; readonly key: { readonly commandFingerprint: string } }): boolean {
  if (plan.command === undefined && plan.report === undefined) return true;
  try { return evalCommandFingerprintOf(plan.command as EvalCommand, plan.report as EvalReportPath) === plan.key.commandFingerprint; } catch { return false; }
}
/** The stored plan. Nothing in it is per task. */
export const EvalPlanBodySchema = EvalPlanBodyShape
  .refine(plan => new Set(plan.questions.map(q => q.id)).size === plan.questions.length, "question ids are unique")
  .refine(evalPlanCommandHolds, "the eval command does not match its stored hash");
export type EvalPlanBody = z.infer<typeof EvalPlanBodySchema>;

export const EvalPlanRecordSchema = z.object({
  entityType: z.literal("EVAL_PLAN"), schemaVersion: z.literal(1),
  company: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u), project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  /** `evalPlanDigest(company, project, plan)`, recomputed on every read. */
  planDigest: hash,
  /** The digest of the EVAL_SPEND item that was proposed with this plan. */
  spendDigest: hash,
  plan: EvalPlanBodySchema,
}).strict();
export type EvalPlanRecord = z.infer<typeof EvalPlanRecordSchema>;

/** The plan's digest under its own domain, bound to its company and project. Throws (zod) for a plan that is not a valid body. */
export const evalPlanDigest = (company: string, project: string, plan: EvalPlanBody): string =>
  sha256HexOf(new TextEncoder().encode(`rovara-eval-plan/v1\n${canonicalJson({ company, project, plan: EvalPlanBodySchema.parse(plan) })}`));

const QUESTION_DOMAIN = new TextEncoder().encode("rovara-eval-question/v1\n");
/** The content hash of a question file: SHA-256 over a fixed domain and the file's exact bytes. Setup and the worker both use this one function. */
export function evalQuestionHash(bytes: Uint8Array): string {
  const joined = new Uint8Array(QUESTION_DOMAIN.length + bytes.length);
  joined.set(QUESTION_DOMAIN, 0); joined.set(bytes, QUESTION_DOMAIN.length);
  return sha256HexOf(joined);
}
/** The head hash of a question whose file the candidate removed: never equal to any content hash, so the question reads "edited". */
export const EVAL_QUESTION_REMOVED_HASH = sha256HexOf(new TextEncoder().encode("rovara-eval-question-removed/v1\n"));

/**
 * The code identity of a base commit for the base-score cache key (`codeHash`). A git commit id commits to every file at that revision, so this is one score per base commit. The broker
 * (from the run's own pinned base) and the worker (from the pinned candidate) compute it the same way; a dependency-keyed hash that reuses a score across commits is a later step.
 */
export function evalCodeHash(baseCommit: string): string {
  if (typeof baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseCommit)) throw new RangeError("the base commit is not a commit id");
  return sha256HexOf(new TextEncoder().encode(`rovara-eval-code/v1\n${baseCommit}`));
}
