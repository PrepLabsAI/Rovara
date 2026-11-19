// DEC 253n(1): the setup run's EVAL DISCOVERY report, sent through its existing setup callback (`POST .../setup-agent`, body kind `eval_discovery`), and the person's CONFIRM of a selection from it.
//
// The report is the run's word, never authority. It is bounded and strict here; the broker keeps it (one per run, never edited) and shows it. Nothing in it is trusted for money or identity:
//   - question HASHES are not in it at all: on confirm the broker reads each selected file at the commit IT recorded for the run (`preparedBase`) and hashes the bytes itself (`evalQuestionHash`);
//   - the eval-set hash, the settings fingerprint and the plan digest are the broker's own, computed from those reads and the confirmed fields;
//   - the command FINGERPRINT the run sends must equal the broker's own `evalCommandFingerprintOf(command, report)`, or the whole report is refused;
//   - DEC 253q: the JUDGE is named (a rule, or a model with its exact version, and its scoring file), never pinned by the run: the broker reads the scoring file at the recorded commit and
//     computes the judge pin itself (`evalJudgePinOf`);
//   - the judge, the model catalog row, the image and the per-question caps are what a maintainer or admin reads and confirms; the spend item they make is approved separately (EVAL_SPEND).
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { EVAL_QUESTION_LIMIT } from "./eval-check.js";
import { EvalCommandSchema, EvalPlanQuestionSchema, EvalReportPathSchema, evalCommandFingerprintOf } from "./eval-plan-record.js";
import { EvalOutputShapeSchema } from "./eval-wrapper.js";
import { sha256HexOf } from "./service-catalog-verify.js";
import { modelBelongsToFamily, type VendorFamily } from "./vendor-family.js";

/** The most suites one report offers, the most distinct question files one suite names (the broker reads each on confirm), and the per-question bounds a report may ask for. */
export const EVAL_DISCOVERY_SUITES_MAX = 4;
export const EVAL_DISCOVERY_FILES_MAX = 100;
export const EVAL_DISCOVERY_CALLS_PER_QUESTION_MAX = 20;
export const EVAL_DISCOVERY_COST_PER_QUESTION_MAX_MICROS = 1_000_000;
/** The largest report (UTF-8 bytes of its canonical JSON) the broker keeps: well under a hosted store's item limit with its row fields. */
export const EVAL_DISCOVERY_REPORT_MAX_BYTES = 256 * 1024;

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

/**
 * DEC 253q: the catalog rows the eval's product route serves (`eval-gateway-access.ts`: the Gemini API row, and the Vertex AI row since L4-EVV), with the vendor family each serves. The product model and a model judge both go
 * through it. The row names which API shape the project's client speaks; the setup draft may name `vertex`, a person confirms it, and the row is part of the judge pin and the spend inputs, so an approval names it.
 */
export const EVAL_PRODUCT_ROW = "gemini";
export const EVAL_VERTEX_ROW = "vertex";
export const EVAL_PRODUCT_ROWS: Readonly<Record<string, VendorFamily>> = Object.freeze({ [EVAL_PRODUCT_ROW]: "google", [EVAL_VERTEX_ROW]: "google" });
/** L4-T3: the words a person knows each row by. A row this install cannot run has no label (the card then says nothing about a provider). */
const EVAL_PRODUCT_ROW_LABELS: Readonly<Record<string, string>> = Object.freeze({ [EVAL_PRODUCT_ROW]: "Google Gemini", [EVAL_VERTEX_ROW]: "Vertex AI" });
export const evalProductRowLabel = (row: unknown): string | undefined => (typeof row === "string" && Object.hasOwn(EVAL_PRODUCT_ROW_LABELS, row) ? EVAL_PRODUCT_ROW_LABELS[row] : undefined);
/** The rows a setup draft may name for its eval's provider. Absent is `gemini`. */
export const EVAL_DRAFT_PROVIDERS = ["gemini", "vertex"] as const;
export type EvalDraftProvider = (typeof EVAL_DRAFT_PROVIDERS)[number];
/**
 * The project and location a sandbox client of a `vertex` eval row is told (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`). They are Rovara's, never the customer's: the worker does not know the connected ones, and the
 * model gateway maps exactly this pair, and only under an eval stage's scope, to the connected project and location (it builds the upstream path from its own key store). Both pass the gateway's path parsers and are not real Google names.
 * The same two words are in the Cloud model gateway (`EVAL_VERTEX_PLACEHOLDER`, product-vertex.ts); a mismatch fails closed (the gateway answers 400 and the eval reads Not run).
 */
export const EVAL_VERTEX_PLACEHOLDER = Object.freeze({ projectId: "rovara-eval-project", location: "rovara-eval1" });
/** The route every eval model call takes: the gateway's product route, on the customer's own connected key (DEC 240b, 253k). */
export const EVAL_PRODUCT_ROUTE = "gateway";
const familyOfRow = (row: string): VendorFamily | undefined => (Object.hasOwn(EVAL_PRODUCT_ROWS, row) ? EVAL_PRODUCT_ROWS[row] : undefined);

/** DEC 253q: the eval's judge as the setup run names it: a rule (exact match and the like: no model) or a model and its exact version, each with the file that holds its scoring rule or prompt. */
export const EvalJudgeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rule"), scoringPath: EvalPlanQuestionSchema.shape.path }).strict(),
  z.object({ kind: z.literal("model"), model: name, version: name, scoringPath: EvalPlanQuestionSchema.shape.path }).strict(),
]);
export type EvalJudge = z.infer<typeof EvalJudgeSchema>;

/**
 * DEC 253q (design note, section 1): the judge pin, computed by the BROKER at confirm. It covers the provider (always the customer's connected key), the catalog row and its vendor family, the
 * judge's kind, model and version, and the scoring file's path and content hash (`evalQuestionHash` of the bytes the broker read at the setup commit). Any change to one is a new pin, so the spend
 * inputs change and the old approval no longer matches. Throws for a judge, row or hash it would not accept.
 */
export function evalJudgePinOf(input: { catalogRowId: string; judge: EvalJudge; scoringHash: string }): string {
  const judge = EvalJudgeSchema.parse(input.judge);
  const family = familyOfRow(input.catalogRowId);
  if (family === undefined || !/^[a-f0-9]{64}$/u.test(input.scoringHash)) throw new RangeError("the judge pin needs an eval product row and a scoring file hash");
  if (judge.kind === "model" && !modelBelongsToFamily(judge.model, family)) throw new RangeError("a model judge goes through the eval's product row");
  const body = { provider: "customer", catalogRowId: input.catalogRowId, family, kind: judge.kind, ...(judge.kind === "model" ? { model: judge.model, version: judge.version } : {}), scoring: { path: judge.scoringPath, hash: input.scoringHash } };
  return sha256HexOf(new TextEncoder().encode(`rovara-eval-judge/v1\n${canonicalJson(body)}`));
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
  /** L4-EVW2 (DEC 254zzz20 D2): what the command writes at `report`, when it is not a file Rovara already reads (a `rows` file or a `custom` shape needs a wrapper the setup agent proposes as a pull request). Absent: readable as before. */
  output: EvalOutputShapeSchema.optional(),
  /**
   * DEC 254zzz43: the setup run's dry-run of the wrapper in its own sandbox, against sample results in the shape it described (and a syntax check for a `custom` file): `passed` = the file read them and wrote the report.
   * Only `passed` makes the file offered. Absent or `failed`: not offered. Informational for the card; never a hash and never trusted for spend.
   */
  wrapperDryRun: z.enum(["passed", "failed"]).optional(),
  /** The run's own fingerprint of `command` and `report`: refused unless it is the broker's `evalCommandFingerprintOf`. */
  commandFingerprint: hash,
  judge: EvalJudgeSchema,
  subsetSupported: z.boolean(),
  catalogRowId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u).refine(row => familyOfRow(row) !== undefined, "a row the eval's product route serves"),
  model: name,
  modelVersion: name,
  image: z.string().regex(EVAL_PINNED_IMAGE),
  route: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/@+-]+$/u),
  maxCallsPerQuestion: z.number().int().min(1).max(EVAL_DISCOVERY_CALLS_PER_QUESTION_MAX),
  maxCostMicrosPerQuestion: z.number().int().min(1).max(EVAL_DISCOVERY_COST_PER_QUESTION_MAX_MICROS),
}).strict()
  .refine(suite => new Set(suite.questions.map(q => q.id)).size === suite.questions.length, "question ids are unique")
  .refine(suite => new Set(suite.questions.map(q => q.path)).size <= EVAL_DISCOVERY_FILES_MAX, "too many question files")
  .refine(suite => { try { return evalCommandFingerprintOf(suite.command, suite.report) === suite.commandFingerprint; } catch { return false; } }, "the command fingerprint does not match the command")
  // The product model and a model judge are both reached through the row, so both belong to its family; the scoring file is not a question.
  .refine(suite => { const family = familyOfRow(suite.catalogRowId); return family !== undefined && modelBelongsToFamily(suite.model, family) && (suite.judge.kind !== "model" || modelBelongsToFamily(suite.judge.model, family)); }, "the models go through the eval's product row")
  .refine(suite => !suite.questions.some(q => q.path === suite.judge.scoringPath), "the scoring file is not a question file");
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
  /**
   * L4-EVC (DEC 254zzz20 D8): ONE approval. `approve: true` confirms the selection AND approves its spend in the same act, for a person the approval rules allow; `seen` is the dollars the
   * person was shown (the most a check can cost, and the monthly cap), which the broker holds against its own figures and refuses on any difference, so what is approved is what the card said.
   */
  approve: z.literal(true).optional(),
  seen: z.object({ perCheckHighMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), monthlyCapMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
}).strict().refine(body => (body.approve === true) === (body.seen !== undefined), "an approval names the dollars it was shown");
export type EvalDiscoveryConfirmBody = z.infer<typeof EvalDiscoveryConfirmBodySchema>;
