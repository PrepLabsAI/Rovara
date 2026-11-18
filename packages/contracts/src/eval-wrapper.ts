// L4-EVW2 (DEC 254zzz20 D2): how the setup run says what the customer's eval WRITES, so Rovara knows whether it can read the result as it is, or whether the setup agent should propose a small wrapper file as a pull
// request on the customer's repository (never an adapter the customer writes). Pure, browser-safe, no model and no host.
//
//   readable as it is   `junit` (pytest `--junitxml`, DeepEval through pytest, Jest and Vitest reports, TRX), `promptfoo` (its JSON results file) and `measures` (Rovara's own file). No wrapper.
//   needs a wrapper     `rows` (a JSON, JSONL or CSV file with one row per case: which field is the id, which says it passed) and `custom` (the setup agent wrote the wrapper itself, because the output fits no known
//                       shape). A `rows` wrapper comes from a code template (no AI at task time); a `custom` one is part of the setup run, under the setup run's own spend.
//
// The wrapper runs the customer's command UNCHANGED, reads what it wrote and writes a JUnit report (one test case per question) at a fixed path Rovara reads. It sits at ONE of two fixed paths in the repository
// (`EVAL_WRAPPER_WRITE_PATHS`); the adapters refuse any other path, so nothing else in the repository can ever be written.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { EVAL_WRAPPER_NODE_PATH, EVAL_WRAPPER_PYTHON_PATH } from "./plugins/code-host.js";
import { sha256HexOf } from "./service-catalog-verify.js";

/** A column or key of a row: a plain word (dots allowed for a nested key, `result.passed`). */
const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,3}$/u);

/** How a row says it passed: a field that equals one value (`passed` is `true`, `verdict` is `"pass"`), or a score at or above a line (taken from the project's own gate). */
export const EvalRowPassSchema = z.union([
  z.object({ field: fieldName, equals: z.union([z.boolean(), z.string().min(1).max(64), z.number().finite()]) }).strict(),
  z.object({ field: fieldName, atLeast: z.number().finite().min(-1_000_000).max(1_000_000) }).strict(),
]);
export type EvalRowPass = z.infer<typeof EvalRowPassSchema>;

export const EVAL_WRAPPER_LANGUAGES = ["python", "node"] as const;
export const EvalWrapperLanguageSchema = z.enum(EVAL_WRAPPER_LANGUAGES);
export type EvalWrapperLanguage = z.infer<typeof EvalWrapperLanguageSchema>;
/** The largest wrapper the setup agent may write itself (UTF-8 bytes). */
export const EVAL_WRAPPER_CUSTOM_MAX_BYTES = 12_000;

export const EvalOutputShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("junit") }).strict(),
  z.object({ kind: z.literal("promptfoo") }).strict(),
  z.object({ kind: z.literal("measures") }).strict(),
  z.object({
    kind: z.literal("rows"),
    format: z.enum(["jsonl", "json", "csv"]),
    language: EvalWrapperLanguageSchema,
    idField: fieldName,
    pass: EvalRowPassSchema,
    /** A `json` file whose rows sit under one key (`{"results": [...]}`); absent: the file is the array. */
    rowsKey: fieldName.optional(),
  }).strict().refine(shape => shape.format === "json" || shape.rowsKey === undefined, "a rows key belongs to a JSON file"),
  z.object({
    kind: z.literal("custom"),
    language: EvalWrapperLanguageSchema,
    /** One plain sentence on what the wrapper reads (shown on the pull request and the setup card). */
    summary: z.string().min(1).max(300).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u),
    source: z.string().min(1).refine(text => new TextEncoder().encode(text).length <= EVAL_WRAPPER_CUSTOM_MAX_BYTES, "the wrapper is too long").refine(text => !text.includes("\u0000"), "no NUL").refine(text => !/[\u202A-\u202E\u2066-\u2069]/u.test(text), "no direction controls"),
  }).strict(),
]);
export type EvalOutputShape = z.infer<typeof EvalOutputShapeSchema>;

/** Whether Rovara cannot read the eval's output as it is: only a `rows` or `custom` output needs a wrapper. Absent (a report from before this) reads as readable, exactly as before. */
export function evalOutputNeedsWrapper(output: EvalOutputShape | undefined): output is Extract<EvalOutputShape, { kind: "rows" | "custom" }> {
  return output !== undefined && (output.kind === "rows" || output.kind === "custom");
}

/** The fixed words on the setup card and the refusals. A found file is how it becomes readable: there is no "run setup again". */
export const EVAL_OUTPUT_UNREADABLE_MESSAGE = "Rovara can't read this eval's results yet. It needs a small file in your repository. Add it yourself or let Rovara open a pull request for it; once the file is on your default branch, approve a test run.";
/** DEC 254zzz43: the one line a pull request carries while the project's eval card was set aside ("Not now") or its file is not there yet. */
export const EVAL_NOT_READ_LINE = "Eval not read: setup needed";
/** The card's title: "Rovara can't read the results of <eval> yet". The eval's name is the repository's own text and is shown as data. */
export const evalWrapperTitleOf = (selection: string): string => `Rovara can't read the results of ${selection} yet`;
/** The version a wrapper file made by Rovara's templates says it is (a line `rovara-eval-wrapper-template: N` in its first lines). Raised when a template changes; a found file with a lower number is out of date. */
export const EVAL_WRAPPER_TEMPLATE_VERSION = 1;
/** The template version a file says it is, or undefined (a file Rovara did not make, or one that lost the line). Reads only the first 8 lines. */
export function evalWrapperTemplateVersionOf(content: string): number | undefined {
  const head = content.split("\n", 8).join("\n");
  const found = /rovara-eval-wrapper-template:\s*([0-9]{1,4})\b/u.exec(head);
  return found === null ? undefined : Number(found[1]);
}

/**
 * DEC 254zzz43: a person's act on the card. `open_pull_request` (the template wrapper only; names the suite), `dismiss` ("Not now", per project), `reopen` (undo Not now) and `check` ("Check now": look for the file on the default
 * branch again). The first three need a company owner, admin or project maintainer; `check` is a read any member may ask.
 */
export const EVAL_WRAPPER_ACTIONS = ["open_pull_request", "dismiss", "reopen", "check"] as const;
export const EvalWrapperActionBodySchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(EVAL_WRAPPER_ACTIONS),
  /** The eval the act is about (`open_pull_request` requires it). */
  selection: z.string().min(1).max(512).regex(/^[^\p{Cc}\p{Cf}]+$/u).optional(),
}).strict().refine(body => body.action !== "open_pull_request" || body.selection !== undefined, "open_pull_request names the eval");
export type EvalWrapperActionBody = z.infer<typeof EvalWrapperActionBodySchema>;

/** Where the wrapper stands for one eval (the card's one word; the line says it in a sentence). */
export const EVAL_WRAPPER_STEPS = ["needs_file", "pull_request_open", "file_found", "file_outdated", "test_approved", "readable", "unreadable", "not_offered", "dismissed"] as const;
export type EvalWrapperStep = (typeof EVAL_WRAPPER_STEPS)[number];
/** Why a person can only copy the file, never have Rovara open a pull request for it. */
export const EVAL_WRAPPER_COPY_REASONS = ["custom", "another_eval", "cannot_write", "file_exists", "closed", "not_checked"] as const;
export type EvalWrapperCopyReason = (typeof EVAL_WRAPPER_COPY_REASONS)[number];
export const EvalWrapperCardSchema = z.object({
  selection: z.string().min(1).max(512),
  repository: z.string().max(200).optional(),
  language: EvalWrapperLanguageSchema,
  /** `template`: made by code from the setup run's description of the output (a pull request may be opened); `custom`: the setup agent's own text (copy only). */
  kind: z.enum(["template", "custom"]),
  /** Where the file goes in the repository and what it holds, for the "View the file" and "I'll add it myself" views (members see and copy them too). */
  path: z.string().min(1).max(200),
  content: z.string().max(EVAL_WRAPPER_CUSTOM_MAX_BYTES * 2),
  summary: z.string().max(300).optional(),
  title: z.string().max(700),
  step: z.enum(EVAL_WRAPPER_STEPS),
  /** One sentence for the step (fixed words; the pull request number is the host's). */
  line: z.string().max(400),
  /** Rovara ran the wrapper in the setup sandbox against sample results and it read them: only then is the file offered. */
  offered: z.boolean(),
  /** Whether a person with the right role may press "Let Rovara open a pull request" now. */
  canOpenPullRequest: z.boolean(),
  copyOnly: z.object({ reason: z.enum(EVAL_WRAPPER_COPY_REASONS), text: z.string().max(400) }).strict().optional(),
  pullRequest: z.object({ number: z.string().max(40).optional(), url: z.string().max(500).optional(), state: z.enum(["opening", "open", "merged", "closed", "failed"]) }).strict().optional(),
  fileStatus: z.enum(["same", "edited", "outdated"]).optional(),
  /** The file was set aside with "Not now" for this report (the PR says "Eval not read: setup needed"; the Evals page keeps a row). */
  dismissed: z.boolean(),
  checkedAt: z.iso.datetime().optional(),
}).strict();
export type EvalWrapperCard = z.infer<typeof EvalWrapperCardSchema>;

/** Where a wrapper of this language lives in the repository (one of the two fixed paths). */
export const evalWrapperPathOf = (language: EvalWrapperLanguage): typeof EVAL_WRAPPER_PYTHON_PATH | typeof EVAL_WRAPPER_NODE_PATH => (language === "python" ? EVAL_WRAPPER_PYTHON_PATH : EVAL_WRAPPER_NODE_PATH);
/** The JUnit report the wrapper writes, a fixed path in the repository (the re-discovered suite's report). */
export const EVAL_WRAPPER_REPORT_PATH = "rovara/eval-wrapper-results.xml";
/** The command a repository's re-discovered suite runs once the wrapper is merged. */
export const evalWrapperCommandOf = (language: EvalWrapperLanguage): { executable: string; args: string[]; cwd: "." } =>
  ({ executable: language === "python" ? "python3" : "node", args: [evalWrapperPathOf(language)], cwd: "." });

/** The digest of what a wrapper is made from: the shape and the command and report it wraps. The same suite and shape give the same digest, so the same proposal is made once. */
export function evalWrapperDigestOf(input: { output: EvalOutputShape; command: unknown; report: unknown }): string {
  return sha256HexOf(new TextEncoder().encode(`rovara-eval-wrapper/v1\n${canonicalJson({ output: input.output, command: input.command, report: input.report })}`));
}
