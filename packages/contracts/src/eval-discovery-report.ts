// DEC 253n(1): the setup run's EVAL DISCOVERY report, sent through its existing setup callback (`POST .../setup-agent`, body kind `eval_discovery`), and the person's CONFIRM of a selection from it.
//
// The report is the run's word, never authority. It is bounded and strict here; the broker keeps it (one per run, never edited) and shows it. Nothing in it is trusted for money or identity:
//   - question HASHES are not in it at all: on confirm the broker reads each selected file at the commit IT recorded for the run (`preparedBase`) and hashes the bytes itself (`evalQuestionHash`);
//   - the eval-set hash, the settings fingerprint and the plan digest are the broker's own, computed from those reads and the confirmed fields;
//   - the command FINGERPRINT the run sends must equal the broker's own `evalCommandFingerprintOf(command, report)`, or the whole report is refused;
//   - the judge pins, the model catalog row, the image and the per-question caps are what a maintainer or admin reads and confirms; the spend item they make is approved separately (EVAL_SPEND).
import { z } from "zod";
import { EVAL_QUESTION_LIMIT } from "./eval-check.js";
import { EvalCommandSchema, EvalPlanQuestionSchema, EvalReportPathSchema, evalCommandFingerprintOf } from "./eval-plan-record.js";

/** The most suites one report offers, the most distinct question files one suite names (the broker reads each on confirm), and the per-question bounds a report may ask for. */
export const EVAL_DISCOVERY_SUITES_MAX = 4;
export const EVAL_DISCOVERY_FILES_MAX = 100;
export const EVAL_DISCOVERY_CALLS_PER_QUESTION_MAX = 20;
export const EVAL_DISCOVERY_COST_PER_QUESTION_MAX_MICROS = 1_000_000;

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/u);
/** A question id the fresh sandbox can pass on (`ROVARA_EVAL_IDS`). */
const questionId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
/** A pinned image: `name@sha256:<64 hex>` or `sha256:<64 hex>`. A tag is refused. */
export const EVAL_PINNED_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._/:-]{0,200}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u;
/** The `sha256:<hex>` digest of a pinned image reference, or undefined. */
export function evalImageDigestOf(image: unknown): string | undefined {
  if (typeof image !== "string" || !EVAL_PINNED_IMAGE.test(image)) return undefined;
  return image.slice(image.lastIndexOf("sha256:"));
}

export const EvalDiscoveryQuestionSchema = z.object({ id: questionId, category: EvalPlanQuestionSchema.shape.category, path: EvalPlanQuestionSchema.shape.path }).strict();

export const EvalDiscoverySuiteSchema = z.object({
  /** The suite's name as the person sees it, and the spend item's selection. */
  selection: z.string().min(1).max(512).regex(/^[^\p{Cc}\p{Cf}]+$/u),
  /** The repository that holds it; optional for a single-repository project. */
  repository: z.string().trim().min(1).max(200).optional(),
  questions: z.array(EvalDiscoveryQuestionSchema).min(1).max(EVAL_QUESTION_LIMIT),
  command: EvalCommandSchema,
  report: EvalReportPathSchema,
  /** The run's own fingerprint of `command` and `report`: refused unless it is the broker's `evalCommandFingerprintOf`. */
  commandFingerprint: hash,
  judgePin: hash,
  baselineJudgePin: hash,
  sameJudgeFamily: z.boolean().optional(),
  subsetSupported: z.boolean(),
  catalogRowId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  model: name,
  modelVersion: name,
  image: z.string().regex(EVAL_PINNED_IMAGE),
  route: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/u),
  maxCallsPerQuestion: z.number().int().min(1).max(EVAL_DISCOVERY_CALLS_PER_QUESTION_MAX),
  maxCostMicrosPerQuestion: z.number().int().min(1).max(EVAL_DISCOVERY_COST_PER_QUESTION_MAX_MICROS),
}).strict()
  .refine(suite => new Set(suite.questions.map(q => q.id)).size === suite.questions.length, "question ids are unique")
  .refine(suite => new Set(suite.questions.map(q => q.path)).size <= EVAL_DISCOVERY_FILES_MAX, "too many question files")
  .refine(suite => { try { return evalCommandFingerprintOf(suite.command, suite.report) === suite.commandFingerprint; } catch { return false; } }, "the command fingerprint does not match the command");
export type EvalDiscoverySuite = z.infer<typeof EvalDiscoverySuiteSchema>;

export const SetupEvalDiscoveryReportSchema = z.object({
  schemaVersion: z.literal(1),
  suites: z.array(EvalDiscoverySuiteSchema).min(1).max(EVAL_DISCOVERY_SUITES_MAX),
}).strict()
  .refine(report => new Set(report.suites.map(s => s.selection)).size === report.suites.length, "suite selections are unique")
  .refine(report => report.suites.reduce((n, s) => n + s.questions.length, 0) <= EVAL_QUESTION_LIMIT, "too many questions");
export type SetupEvalDiscoveryReport = z.infer<typeof SetupEvalDiscoveryReportSchema>;

/** The person's confirm: which run's report (its id and the digest they saw), which suite, and which of its question files. Nothing else is taken from the request. */
export const EvalDiscoveryConfirmBodySchema = z.object({
  taskId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u),
  reportDigest: hash,
  selection: z.string().min(1).max(512),
  paths: z.array(EvalPlanQuestionSchema.shape.path).min(1).max(EVAL_DISCOVERY_FILES_MAX).refine(paths => new Set(paths).size === paths.length, "each file once"),
}).strict();
export type EvalDiscoveryConfirmBody = z.infer<typeof EvalDiscoveryConfirmBodySchema>;
